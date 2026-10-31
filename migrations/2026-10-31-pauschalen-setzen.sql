-- ============================================================================
-- Pauschalen in HYDRAlink – Schritt 1: Speichern im Dashboard
-- Spec: docs/superpowers/specs/2026-10-31-pauschalen-design.md
-- Datum: 2026-10-31
--
-- * Spalte fahrer_nr -> notion_fahrer_id (wie fahrer_bank; das Protokoll findet darüber den Fahrernamen)
-- * pauschale_spalten(): Verlaufszeile -> die vier fahrer-Spalten, die Bot & Co. lesen
-- * pauschalen_anwenden(): schreibt die Pauschale der Stichwoche nach fahrer
-- * pauschale_setzen(): einziger Schreibweg fürs Büro (alle Büro-Benutzer, Name aus dem JWT)
-- * Protokoll-Trigger, Bereich 'geld'
-- Der Wächter gegen den Notion-Sync kommt erst mit 2026-10-31-pauschalen-scharf.sql.
--
-- Rollback: drop function pauschale_setzen, pauschalen_anwenden, pauschale_spalten;
--   drop trigger protokoll_mitschreiben on pauschalen; alter table pauschalen rename notion_fahrer_id to fahrer_nr
--   (danach pauschale_fuer/pauschalen_abweichung/pauschalen_uebernehmen aus der Übernahme-Migration neu anlegen)
-- ============================================================================

alter table public.pauschalen rename column fahrer_nr to notion_fahrer_id;

create or replace function public.pauschale_fuer(p_fahrer_nr integer, p_woche text)
returns public.pauschalen language sql stable security invoker set search_path = public as $$
  select p.* from public.pauschalen p
   where p.notion_fahrer_id = p_fahrer_nr and p.gilt_ab <= p_woche and (p.gilt_bis is null or p.gilt_bis >= p_woche)
   order by p.am desc, p.id desc limit 1
$$;

drop view if exists public.pauschalen_abweichung;
create view public.pauschalen_abweichung with (security_invoker = true) as
with s as (select public.pauschale_stichwoche() as woche),
f as (
  select f.id, f.notion_fahrer_id as nr, f.name, f.mietmodell, f.basis_miete, f.prozent_satz, f.prozent_schwelle,
         a.art as f_art, a.prozent_satz as f_satz, a.prozent_schwelle as f_schwelle
    from public.fahrer f, lateral public.pauschale_aus_fahrer(f.mietmodell, f.prozent_satz, f.prozent_schwelle) a
   where f.aktiv and f.notion_fahrer_id is not null
)
select f.nr as notion_fahrer_id, f.name, s.woche as stichwoche,
       f.f_art as fahrer_art, f.basis_miete as fahrer_betrag, f.f_satz as fahrer_satz, f.f_schwelle as fahrer_schwelle,
       p.art, p.betrag, p.prozent_satz, p.prozent_schwelle,
       case when p.id is null then 'kein Eintrag' else 'weicht ab' end as befund
  from f cross join s
  left join lateral public.pauschale_fuer(f.nr, s.woche) p on true
 where p.id is null
    or (p.art, p.betrag, p.prozent_satz, p.prozent_schwelle)
       is distinct from (f.f_art, f.basis_miete::numeric(10,2), f.f_satz::numeric(5,2), f.f_schwelle::numeric(10,2));

create or replace function public.pauschalen_uebernehmen() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.pauschalen (notion_fahrer_id, art, betrag, prozent_satz, prozent_schwelle, gilt_ab, quelle, von)
  select distinct on (a.notion_fahrer_id) a.notion_fahrer_id, a.fahrer_art, a.fahrer_betrag, a.fahrer_satz, a.fahrer_schwelle,
         a.stichwoche, 'uebernahme', 'Übernahme aus Notion'
    from public.pauschalen_abweichung a
   order by a.notion_fahrer_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pauschalen_uebernehmen() from public, anon, authenticated;

-- Verlaufszeile -> fahrer-Spalten (so rechnen Bot, api_abrechnung, prozent_nach_regel und das Dashboard)
create or replace function public.pauschale_spalten(p public.pauschalen,
  out mietmodell text, out basis_miete numeric, out prozent_satz numeric, out prozent_schwelle numeric)
language sql immutable set search_path = public as $$
  select p.art, p.betrag,
         case p.art when 'f11' then 10 when 'f12' then 10 when 'eigene' then p.prozent_satz else 0 end,
         case p.art when 'f11' then 1100 when 'f12' then 1200 when 'eigene' then p.prozent_schwelle else 0 end
$$;

-- Schreibt die Pauschale der Stichwoche in alle fahrer-Zeilen (einer Nr. oder aller). Nur wo sich etwas ändert.
create or replace function public.pauschalen_anwenden(p_nr integer default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; v_woche text := public.pauschale_stichwoche();
begin
  update public.fahrer f
     set mietmodell = s.mietmodell, basis_miete = s.basis_miete, prozent_satz = s.prozent_satz, prozent_schwelle = s.prozent_schwelle
    from (select f2.id, x.*
            from public.fahrer f2,
                 lateral public.pauschale_fuer(f2.notion_fahrer_id, v_woche) p,
                 lateral public.pauschale_spalten(p) x
           where f2.notion_fahrer_id is not null and (p_nr is null or f2.notion_fahrer_id = p_nr) and p.id is not null) s
   where f.id = s.id
     and (f.mietmodell, f.basis_miete, f.prozent_satz, f.prozent_schwelle)
         is distinct from (s.mietmodell, s.basis_miete, s.prozent_satz, s.prozent_schwelle);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pauschalen_anwenden(integer) from public, anon, authenticated;

-- Einziger Schreibweg fürs Büro. Gilt frühestens ab der Stichwoche (frühere Wochen sind freigegeben).
create or replace function public.pauschale_setzen(
  p_nr integer, p_art text, p_betrag numeric,
  p_prozent_satz numeric default null, p_prozent_schwelle numeric default null,
  p_gilt_ab text default null, p_gilt_bis text default null, p_grund text default null)
returns public.pauschalen language plpgsql security definer set search_path = public as $$
declare
  v_stich text := public.pauschale_stichwoche();
  v_ab    text := coalesce(nullif(btrim(p_gilt_ab), ''), v_stich);
  v_bis   text := nullif(btrim(p_gilt_bis), '');
  v_wer   text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
  v_row   public.pauschalen;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if not exists (select 1 from public.fahrer where notion_fahrer_id = p_nr) then
    raise exception 'Fahrer Nr. % nicht gefunden', p_nr using errcode = '22023'; end if;
  if p_art is null or p_art not in ('fix', 'f11', 'f12', 'eigene') then
    raise exception 'Unbekannte Art: %', p_art using errcode = '22023'; end if;
  if p_betrag is null or p_betrag < 0 or p_betrag > 5000 then
    raise exception 'Pauschale muss zwischen 0 und 5.000 € liegen' using errcode = '22023'; end if;
  if p_art = 'eigene' and (p_prozent_satz is null or p_prozent_satz <= 0 or p_prozent_satz > 100) then
    raise exception 'Prozentsatz muss größer 0 und höchstens 100 sein' using errcode = '22023'; end if;
  if p_art = 'eigene' and (p_prozent_schwelle is null or p_prozent_schwelle < 0) then
    raise exception 'Umsatzschwelle fehlt (0 € = vom ganzen Umsatz)' using errcode = '22023'; end if;
  if v_ab !~ '^\d{4}-W\d{2}$' or (v_bis is not null and v_bis !~ '^\d{4}-W\d{2}$') then
    raise exception 'Woche im Format JJJJ-Wnn angeben' using errcode = '22023'; end if;
  if v_ab < v_stich then
    raise exception 'Gilt frühestens ab % – frühere Wochen sind schon freigegeben (dort Zu-/Abschlag)', v_stich using errcode = '22023'; end if;
  if v_bis is not null and v_bis < v_ab then
    raise exception '„bis“ liegt vor „gilt ab“' using errcode = '22023'; end if;

  insert into public.pauschalen (notion_fahrer_id, art, betrag, prozent_satz, prozent_schwelle, gilt_ab, gilt_bis, grund, quelle, von)
  values (p_nr, p_art, round(p_betrag, 2),
          case when p_art = 'eigene' then p_prozent_satz end, case when p_art = 'eigene' then p_prozent_schwelle end,
          v_ab, v_bis, nullif(left(btrim(coalesce(p_grund, '')), 200), ''), 'hand', v_wer)
  returning * into v_row;

  perform public.pauschalen_anwenden(p_nr);
  return v_row;
end $$;
revoke all on function public.pauschale_setzen(integer, text, numeric, numeric, numeric, text, text, text) from public, anon;
grant execute on function public.pauschale_setzen(integer, text, numeric, numeric, numeric, text, text, text) to authenticated;
grant execute on function public.pauschale_stichwoche() to authenticated;

-- Protokoll (Büro schreibt über pauschale_setzen)
drop trigger if exists protokoll_mitschreiben on public.pauschalen;
create trigger protokoll_mitschreiben after insert or update or delete on public.pauschalen
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

create or replace function public.protokoll_bereich(p_tabelle text) returns text
language sql immutable set search_path = public as $$
  select case p_tabelle
    when 'settlements' then 'geld' when 'abrechnung_posten' then 'geld' when 'kassier_zahlungen' then 'geld'
    when 'fahrer_bank' then 'geld' when 'bank_bestaetigung' then 'geld' when 'auszahlung_export' then 'geld'
    when 'revolut_zahlungen' then 'geld' when 'revolut_buchungen' then 'geld' when 'revolut_gegenpartei_zuordnung' then 'geld'
    when 'auszahlung_weg' then 'geld' when 'bar_auszahlungen' then 'geld' when 'pauschalen' then 'geld'
    when 'abrechnung_freigaben' then 'freigaben'
    when 'post_eingang' then 'post' when 'mietverhaeltnisse' then 'post' when 'post_ausgang' then 'post'
    when 'zuordnung_manuell' then 'zuordnungen' when 'lohn_personen' then 'zuordnungen' when 'name_aliases' then 'zuordnungen'
    when 'fahrer_app_zugang' then 'zugaenge'
    when 'customers' then 'stammdaten' when 'companies' then 'stammdaten'
    when 'kassabuch' then 'kassa' when 'sync_runs' then 'sync'
    else 'sonst' end
$$;
