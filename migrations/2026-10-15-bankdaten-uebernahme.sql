-- ============================================================================
-- Bankdaten aus dem oeffentlichen Formular (~/Projects/iban-formular, Tabelle fahrer_iban) uebernehmen
-- Datum: 2026-10-15. EINMALIG fuer Eintraege bis zum Stichtag 15.10.2026: das Formular ist oeffentlich,
-- spaetere Eintraege ordnet nur das Buero zu (Dashboard), nie automatisch.
--
-- Zuordnung zu genau einem aktiven Fahrer mit Notion-Nr.: zuerst ueber die Telefonnummer (tel_key),
-- sonst ueber den Namen (name_key, Reihenfolge egal) oder einen Namens-Alias. Das Formular hatte
-- live fast nie eine Telefonnummer (15.10.: 12 von 13 leer).
-- Je Fahrer gewinnt der neueste gueltige Eintrag; aeltere werden 'ueberholt'.
-- Hat der Fahrer schon Bankdaten (App oder Buero), wird NICHTS ueberschrieben.
-- Der Rest bleibt 'neu' und steht im Dashboard (View formular_iban_offen).
-- ============================================================================

alter table public.fahrer_iban add column if not exists uebernommen_nr integer;
-- Das Formular kennt nur neu/geprueft/abgelehnt; die Uebernahme braucht zwei Zustaende mehr.
alter table public.fahrer_iban drop constraint if exists fahrer_iban_status_check;
alter table public.fahrer_iban add constraint fahrer_iban_status_check
  check (status = any (array['neu', 'geprueft', 'abgelehnt', 'uebernommen', 'ueberholt']));

-- Notion-Nr. des einen passenden Fahrers, sonst null. p_anzahl: wie viele Fahrer passen (0, 1, >1).
create or replace function public.formular_iban_fahrer(p_telefon text, p_vorname text, p_nachname text,
                                                       out p_nr integer, out p_anzahl integer)
language plpgsql stable security definer set search_path = public as $$
declare v_name text := btrim(coalesce(p_vorname, '') || ' ' || coalesce(p_nachname, ''));
begin
  -- Fahrer-Logins bekommen nichts (sonst liesse sich die Nr. zu Name/Telefon erfragen);
  -- Buero und die Migration selbst (ohne Anmeldung) schon.
  if auth.uid() is not null and not public.is_app_user() then return; end if;
  if public.tel_key(p_telefon) <> '' then
    select min(f.notion_fahrer_id), count(distinct f.notion_fahrer_id) into p_nr, p_anzahl
    from public.fahrer f
    where f.aktiv and f.notion_fahrer_id is not null and public.tel_key(f.telefon) = public.tel_key(p_telefon);
    if p_anzahl = 1 then return; end if;
  end if;
  select min(f.notion_fahrer_id), count(distinct f.notion_fahrer_id) into p_nr, p_anzahl
  from public.fahrer f
  where f.aktiv and f.notion_fahrer_id is not null
    and ((public.name_key(v_name) <> '' and public.name_key(f.name) = public.name_key(v_name))
         or f.name = (select a.fahrer_name from public.name_aliases a where a.csv_name = lower(v_name)));
  if p_anzahl <> 1 then p_nr := null; end if;
end $$;
revoke all on function public.formular_iban_fahrer(text, text, text) from public, anon;
grant execute on function public.formular_iban_fahrer(text, text, text) to authenticated;   -- fuer die View formular_iban_offen

do $$
declare r record;
begin
  for r in
    with treffer as (
      select i.*, (public.formular_iban_fahrer(i.telefon, i.vorname, i.nachname)).p_nr as nr
      from public.fahrer_iban i
      where i.status = 'neu' and public.iban_gueltig(i.iban)
        and i.erstellt_am < timestamptz '2026-10-16 00:00 Europe/Vienna'   -- Stichtag, siehe Kopf
    )
    select t.*, row_number() over (partition by t.nr order by t.erstellt_am desc, t.id desc) as rang
    from treffer t
    where t.nr is not null
      and not exists (select 1 from public.fahrer_bank b where b.notion_fahrer_id = t.nr)
    order by t.nr, rang
  loop
    if r.rang = 1 then
      perform public.bank_schreiben(r.nr, r.kontoinhaber, r.iban, r.bic, r.revtag, 'formular');
      update public.fahrer_iban set status = 'uebernommen', uebernommen_nr = r.nr where id = r.id;
    else
      update public.fahrer_iban set status = 'ueberholt', uebernommen_nr = r.nr where id = r.id;
    end if;
  end loop;
end $$;

-- Was das Buero noch zuordnen muss
create or replace view public.formular_iban_offen with (security_invoker = true) as
select i.id, i.erstellt_am, btrim(i.vorname || ' ' || i.nachname) as name, i.telefon, i.kontoinhaber,
       case when length(public.iban_norm(i.iban)) > 8
            then substr(public.iban_norm(i.iban), 1, 4) || ' •••• ' || right(public.iban_norm(i.iban), 4)
            else public.iban_norm(i.iban) end as iban_kurz,
       case when not public.iban_gueltig(i.iban) then 'IBAN ungültig'
            when (public.formular_iban_fahrer(i.telefon, i.vorname, i.nachname)).p_anzahl = 0 then 'kein passender Fahrer (Name/Telefon)'
            when (public.formular_iban_fahrer(i.telefon, i.vorname, i.nachname)).p_anzahl > 1 then 'mehrere Fahrer passen'
            when exists (select 1 from public.fahrer_bank b
                         where b.notion_fahrer_id = (public.formular_iban_fahrer(i.telefon, i.vorname, i.nachname)).p_nr)
              then 'Fahrer hat schon Bankdaten'
            else (select 'passt zu ' || f.name || ' (Nr. ' || f.notion_fahrer_id || ')' from public.fahrer f
                  where f.aktiv and f.notion_fahrer_id = (public.formular_iban_fahrer(i.telefon, i.vorname, i.nachname)).p_nr
                  limit 1) end as grund
from public.fahrer_iban i
where i.status = 'neu' and public.is_app_user();
revoke all on public.formular_iban_offen from public, anon;
grant select on public.formular_iban_offen to authenticated;

-- Ein Eintrag aus dem oeffentlichen Formular ueberschreibt vorhandene Bankdaten nur ausdruecklich
-- (p_ueberschreiben, im Dashboard mit Rueckfrage alt gegen neu).
drop function if exists public.formular_iban_zuordnen(bigint, integer);
create or replace function public.formular_iban_zuordnen(p_id bigint, p_notion_fahrer_id integer,
                                                         p_ueberschreiben boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare i public.fahrer_iban;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into i from public.fahrer_iban where id = p_id and status = 'neu' for update;
  if i.id is null then raise exception 'Eintrag % nicht offen', p_id using errcode = 'P0002'; end if;
  if not public.iban_gueltig(i.iban) then raise exception 'IBAN ungültig – bitte beim Fahrer nachfragen' using errcode = '22023'; end if;
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein aktiver Fahrer mit Nr. %', p_notion_fahrer_id using errcode = 'P0002'; end if;
  if not coalesce(p_ueberschreiben, false) and exists (select 1 from public.fahrer_bank where notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Fahrer hat schon Bankdaten – nur mit ausdrücklichem Überschreiben' using errcode = 'P0001'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, i.kontoinhaber, i.iban, i.bic, i.revtag,
          'formular (' || coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro') || ')');
  update public.fahrer_iban set status = 'uebernommen', uebernommen_nr = p_notion_fahrer_id where id = p_id;
end $$;
revoke all on function public.formular_iban_zuordnen(bigint, integer, boolean) from public, anon;
grant execute on function public.formular_iban_zuordnen(bigint, integer, boolean) to authenticated;

-- Falsche oder fremde Eintraege aus dem Formular wegschieben
create or replace function public.formular_iban_verwerfen(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  update public.fahrer_iban set status = 'abgelehnt' where id = p_id and status = 'neu';
  if not found then raise exception 'Eintrag % nicht offen', p_id using errcode = 'P0002'; end if;
end $$;
revoke all on function public.formular_iban_verwerfen(bigint) from public, anon;
grant execute on function public.formular_iban_verwerfen(bigint) to authenticated;

drop policy if exists buero_liest on public.fahrer_iban;
create policy buero_liest on public.fahrer_iban for select to authenticated using (public.is_app_user());
grant select on public.fahrer_iban to authenticated;
