-- ============================================================================
-- Autoliste – Scharfschalten: HYDRAlink entscheidet das Kennzeichen
-- Spec: docs/superpowers/specs/2026-11-01-autoliste-design.md
--
-- ERST EINSPIELEN, wenn Dashboard (Autoliste) und das Zurückschreiben nach Notion live sind.
-- Danach überschreibt der Wächter, was der n8n-Full-Sync in fahrer.kennzeichen schreibt, mit der
-- Zuordnung aus fahrer_auto. Fahrer ohne Verlauf (nur über Notion gekommen) werden einmal übernommen.
-- Nicht Montag 04:00–08:00 Wien einspielen.
--
-- Rollback: drop trigger fahrer_auto_waechter on fahrer; drop function fahrer_auto_waechter;
-- ============================================================================

-- Startstand aus Notion (wiederholbar: wer schon Verlauf hat, bekommt nichts)
select public.fahrer_auto_uebernehmen() as uebernommen;

create or replace function public.fahrer_auto_waechter() returns trigger
language plpgsql security definer set search_path = public as $$
declare v public.fahrer_auto; v_kz text; v_key text;
begin
  if new.notion_fahrer_id is null then return new; end if;
  begin
    select * into v from public.fahrer_auto_aktuell where notion_fahrer_id = new.notion_fahrer_id;
    if v.id is not null then
      new.kennzeichen := v.kennzeichen;
    elsif coalesce(new.aktiv, false) and public.kennzeichen_anzeige(new.kennzeichen) is not null then
      v_kz := public.kennzeichen_anzeige(new.kennzeichen);
      -- Schlüssel des Autos aus dem Fuhrpark (Notion-Titel kann Zusätze wie „(neu)“ haben), sonst aus der Anzeigeform
      select fp.kennzeichen_key into v_key from public.fuhrpark fp
       where fp.kennzeichen_key in (public.kennzeichen_key(new.kennzeichen), public.kennzeichen_key(v_kz))
       order by (fp.kennzeichen_key = public.kennzeichen_key(v_kz)) desc limit 1;
      insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
      values (new.notion_fahrer_id, coalesce(v_key, public.kennzeichen_key(v_kz)), v_kz, 'notion', 'Automatik (aus Notion)');
      new.kennzeichen := v_kz;
    end if;
  exception when others then
    raise warning 'fahrer_auto_waechter(Nr. %): %', new.notion_fahrer_id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.fahrer_auto_waechter() from public, anon, authenticated;
drop trigger if exists fahrer_auto_waechter on public.fahrer;
create trigger fahrer_auto_waechter before insert or update on public.fahrer
  for each row execute function public.fahrer_auto_waechter();
