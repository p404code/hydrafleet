-- ============================================================================
-- Pauschalen in HYDRAlink – Scharfschalten
-- Spec: docs/superpowers/specs/2026-10-31-pauschalen-design.md
--
-- ERST EINSPIELEN, wenn Dashboard (Formular) und Bot-Zeile live gehen. Danach zählt für die Pauschale
-- nur noch HYDRAlink: was der Notion-Sync in fahrer.mietmodell/basis_miete/prozent_* schreibt, wird
-- durch die gültige Pauschale der Stichwoche ersetzt. Nicht Montag 04:00–08:00 Wien einspielen.
--
-- Rollback: drop trigger fahrer_pauschale_waechter on fahrer; drop trigger pauschalen_nach_freigabe on abrechnung_freigaben;
--   drop function fahrer_pauschale_waechter, pauschalen_nach_freigabe;
-- ============================================================================

-- Notion-Änderungen seit der Übernahme noch mitnehmen (je Fahrer eine neue Übernahme-Zeile)
select public.pauschalen_uebernehmen() as nachgezogen;

-- Wächter: fahrer-Spalten = Pauschale der Stichwoche. Kein Eintrag (neuer/reaktivierter Fahrer aus Notion)
-- -> einmalige Übernahme der ankommenden Werte. Darf den n8n-Sync nie scheitern lassen.
create or replace function public.fahrer_pauschale_waechter() returns trigger
language plpgsql security definer set search_path = public as $$
declare v public.pauschalen; s record; v_woche text;
begin
  if new.notion_fahrer_id is null then return new; end if;
  begin
    v_woche := public.pauschale_stichwoche();
    v := public.pauschale_fuer(new.notion_fahrer_id, v_woche);
    if v.id is null then
      if coalesce(new.aktiv, false) then
        insert into public.pauschalen (notion_fahrer_id, art, betrag, prozent_satz, prozent_schwelle, gilt_ab, quelle, von)
        select new.notion_fahrer_id, a.art, coalesce(new.basis_miete, 0), a.prozent_satz, a.prozent_schwelle,
               v_woche, 'neuanlage', 'Automatik (neu aus Notion)'
          from public.pauschale_aus_fahrer(new.mietmodell, new.prozent_satz, new.prozent_schwelle) a;
      end if;
      return new;
    end if;
    select * into s from public.pauschale_spalten(v);
    new.mietmodell := s.mietmodell; new.basis_miete := s.basis_miete;
    new.prozent_satz := s.prozent_satz; new.prozent_schwelle := s.prozent_schwelle;
  exception when others then
    raise warning 'fahrer_pauschale_waechter(Nr. %): %', new.notion_fahrer_id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.fahrer_pauschale_waechter() from public, anon, authenticated;
drop trigger if exists fahrer_pauschale_waechter on public.fahrer;
create trigger fahrer_pauschale_waechter before insert or update on public.fahrer
  for each row execute function public.fahrer_pauschale_waechter();

-- Mit jeder Freigabe rückt die Stichwoche weiter: Befristungen beginnen/enden von selbst.
create or replace function public.pauschalen_nach_freigabe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.pauschalen_anwenden(null);
  exception when others then
    raise warning 'pauschalen_nach_freigabe: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.pauschalen_nach_freigabe() from public, anon, authenticated;
drop trigger if exists pauschalen_nach_freigabe on public.abrechnung_freigaben;
create trigger pauschalen_nach_freigabe after insert or delete on public.abrechnung_freigaben
  for each statement execute function public.pauschalen_nach_freigabe();

select public.pauschalen_anwenden(null) as angewendet;
