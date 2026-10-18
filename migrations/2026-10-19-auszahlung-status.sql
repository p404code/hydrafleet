-- ============================================================================
-- Auszahlungs-Status je Fahrer und Woche (Spec docs/superpowers/specs/2026-10-18-auszahlung-uebersicht-design.md)
-- Datum: 2026-10-19
--
-- Eine Stelle rechnet: auszahlung_status_basis(woche). Daraus lesen die Uebersicht (auszahlung_status, Buero),
-- der Revolut-Entwurf (revolut_kandidaten, service_role) und die Fahrerapp (fahrer_app_auszahlung, nur Ueberweisungen).
-- Weg: Hand-Umstellung (auszahlung_weg) > gepruefte Bankdaten = revolut > bar.
-- Bar: je Fahrer bar_auszahlen -> Kassabuch-Ausgabe (quelle 'bar'); rueckgaengig nur ueber bar_rueckgaengig (Gegenbuchung).
-- Wochen, die schon gesamt ins Kassabuch uebernommen sind, gelten als bar ausgezahlt (Status bar_woche, auch bei Weg revolut);
-- umgekehrt sperrt
-- eine Bar-Zeile die Wochenbuchung (Trigger kassa_bar_sperre).
-- Bewusst: ein Rest (rest_offen) wird bar beglichen - ein zweiter Revolut-Posten je Woche/Fahrer ist nicht vorgesehen.
--
-- Rollback: drop function fahrer_app_auszahlung, bar_rueckgaengig, bar_auszahlen, auszahlung_weg_setzen, auszahlung_status,
--   auszahlung_status_basis; drop trigger kassa_bar_sperre on kassabuch; drop function kassa_bar_sperre;
--   drop table bar_auszahlungen, auszahlung_weg; kassa_abrechnung_stand aus 2026-10-03-kassabuch-abrechnung.sql und
--   revolut_kandidaten aus 2026-10-18-revolut-vorschuss.sql neu einspielen; quelle-Check ohne 'bar'.
-- ============================================================================

create table if not exists public.auszahlung_weg (
  woche            text not null,
  notion_fahrer_id integer not null,
  weg              text not null check (weg in ('revolut', 'bar')),
  geaendert_von    text not null,
  geaendert_am     timestamptz not null default now(),
  primary key (woche, notion_fahrer_id)
);

create table if not exists public.bar_auszahlungen (
  id                  bigint generated always as identity primary key,
  woche               text not null,
  notion_fahrer_id    integer not null,
  name                text not null,
  betrag              numeric(10,2) not null check (betrag > 0),
  kassabuch_id        bigint not null,
  ausgezahlt_am       timestamptz not null default now(),
  ausgezahlt_von      text not null,
  storno_kassabuch_id bigint,
  storniert_am        timestamptz,
  storniert_von       text
);
create index if not exists bar_auszahlungen_woche on public.bar_auszahlungen (woche, notion_fahrer_id);

alter table public.auszahlung_weg enable row level security;
alter table public.bar_auszahlungen enable row level security;
revoke all on public.auszahlung_weg, public.bar_auszahlungen from public, anon, authenticated;
grant select on public.auszahlung_weg, public.bar_auszahlungen to authenticated;
drop policy if exists buero_liest on public.auszahlung_weg;
drop policy if exists buero_liest on public.bar_auszahlungen;
create policy buero_liest on public.auszahlung_weg for select to authenticated using (public.is_app_user());
create policy buero_liest on public.bar_auszahlungen for select to authenticated using (public.is_app_user());
drop trigger if exists protokoll_mitschreiben on public.auszahlung_weg;
create trigger protokoll_mitschreiben after insert or update or delete on public.auszahlung_weg
  for each row execute function public.protokoll_schreiben('woche,notion_fahrer_id', 'ohne', '', '');
drop trigger if exists protokoll_mitschreiben on public.bar_auszahlungen;
create trigger protokoll_mitschreiben after insert or update or delete on public.bar_auszahlungen
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

create or replace function public.protokoll_bereich(p_tabelle text) returns text
language sql immutable set search_path = public as $$
  select case p_tabelle
    when 'settlements' then 'geld' when 'abrechnung_posten' then 'geld' when 'kassier_zahlungen' then 'geld'
    when 'fahrer_bank' then 'geld' when 'bank_bestaetigung' then 'geld' when 'auszahlung_export' then 'geld'
    when 'revolut_zahlungen' then 'geld' when 'revolut_buchungen' then 'geld' when 'revolut_gegenpartei_zuordnung' then 'geld'
    when 'auszahlung_weg' then 'geld' when 'bar_auszahlungen' then 'geld'
    when 'abrechnung_freigaben' then 'freigaben'
    when 'post_eingang' then 'post' when 'mietverhaeltnisse' then 'post' when 'post_ausgang' then 'post'
    when 'zuordnung_manuell' then 'zuordnungen' when 'lohn_personen' then 'zuordnungen' when 'name_aliases' then 'zuordnungen'
    when 'fahrer_app_zugang' then 'zugaenge'
    when 'customers' then 'stammdaten' when 'companies' then 'stammdaten'
    when 'kassabuch' then 'kassa' when 'sync_runs' then 'sync'
    else 'sonst' end
$$;

-- Kassabuch: neue Quelle 'bar'
alter table public.kassabuch drop constraint if exists kassabuch_quelle_check;
alter table public.kassabuch add constraint kassabuch_quelle_check
  check (quelle in ('hand', 'abrechnung', 'posten', 'anfang', 'bar'));

-- Wochenbuchung und Bar je Fahrer schliessen sich aus
create or replace function public.kassa_bar_sperre() returns trigger language plpgsql set search_path = public as $$
begin
  if new.quelle = 'abrechnung' and new.woche_abr is not null
     and exists (select 1 from public.bar_auszahlungen b where b.woche = new.woche_abr) then
    raise exception 'In % wird schon je Fahrer bar ausgezahlt – die Wochenbuchung geht hier nicht', public.kassa_kw(new.woche_abr)
      using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists kassa_bar_sperre on public.kassabuch;
create trigger kassa_bar_sperre before insert on public.kassabuch for each row execute function public.kassa_bar_sperre();

-- Kassabuch-Reiter: Wochen im Bar-je-Fahrer-Modus nicht mehr als "zu uebernehmen" zeigen (sonst wie bisher)
create or replace function public.kassa_abrechnung_stand()
returns table (woche text, fahrer integer, soll numeric, gebucht numeric, differenz numeric, uebernommen boolean, posten_offen integer)
language plpgsql security definer set search_path = public as $$
declare v_ab text;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select to_char(datum - 7, 'IYYY-"W"IW') into v_ab from public.kassabuch where art = 'anfang';
  if v_ab is null then return; end if;
  return query
  select s.woche, count(*)::integer,
         round(sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)), 2),
         coalesce(k.netto, 0), round(sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)), 2) - coalesce(k.netto, 0),
         coalesce(k.uebernommen, false),
         (select count(*)::integer from public.abrechnung_posten_offen o where o.woche = s.woche)
  from public.settlements s
  left join lateral (
    select sum(case kb.art when 'aus' then kb.betrag else -kb.betrag end) as netto,
           bool_or(kb.quelle = 'abrechnung') as uebernommen
    from public.kassabuch kb where kb.woche_abr = s.woche and kb.quelle <> 'bar'
  ) k on true
  where s.woche ~ '^\d{4}-W\d{2}$' and s.woche >= v_ab and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    and not exists (select 1 from public.bar_auszahlungen b where b.woche = s.woche)
  group by s.woche, k.netto, k.uebernommen
  order by s.woche;
end $$;

-- Woche aus einer Ueberweisungs-Referenz: "Auszahlung KW41/26 FHR-1", "W40", "40", "40b" -> 41/40; sonst null
create or replace function public.referenz_kw(p text) returns integer
language sql immutable set search_path = public as $$
  select coalesce(substring(upper(p) from 'K?W ?0*([0-9]{1,2})'), substring(p from '^\s*0*([0-9]{1,2})[A-Za-z]?\s*$'))::integer
$$;

-- Gehoert eine Ueberweisung zur Woche? Mit KW in der Referenz: genau diese Woche, nach Wochenende (hoechstens 60 Tage spaeter,
-- sonst Vorjahr). Ohne KW: ab der Freigabe der Woche.
create or replace function public.buchung_fuer_woche(p_ref text, p_am timestamptz, p_woche text, p_freigegeben timestamptz)
returns boolean language sql immutable set search_path = public as $$
  select case when public.referenz_kw(p_ref) is not null
              then public.referenz_kw(p_ref) = (substring(p_woche from 'W(\d{2})'))::integer
                   and p_am >= to_date(left(p_woche, 8), 'IYYY-"W"IW') + 7
                   and p_am < to_date(left(p_woche, 8), 'IYYY-"W"IW') + 67
              else p_freigegeben is not null and p_am >= p_freigegeben end
$$;

-- Die Rechnung. Nicht direkt aufrufbar (siehe revoke); nur ueber die Wrapper unten.
-- Ein CSV-Export zaehlt nur, solange es zu seiner Referenz noch keine echte Revolut-Buchung gibt (sonst doppelt).
create or replace function public.auszahlung_status_basis(p_woche text)
returns table (notion_fahrer_id integer, fahrer_id integer, name text, zeilen bigint[], betrag numeric, weg text, weg_hand boolean,
               geprueft boolean, status text, bezahlt numeric, offen numeric, bezahlt_revolut numeric, bezahlt_bar numeric,
               zuletzt timestamptz, revolut_status text, revolut_fehler text, iban_ende text, kassa_woche boolean)
language sql stable security definer set search_path = public as $$
  with fr as (select freigegeben_am from public.abrechnung_freigaben where woche = p_woche),
  kw as (select exists (select 1 from public.kassabuch k where k.quelle = 'abrechnung' and k.woche_abr = p_woche) as ja),
  z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           round(sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)), 2) as betrag,
           array_agg(s.id::bigint order by s.id) as zeilen
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    group by 1
  ),
  b as (
    select f.notion_fahrer_id as nr, f.id as fid, f.name, z.zeilen, z.betrag,
           aw.weg as weg_hand, coalesce(fb.geprueft, false) as geprueft, right(fb.iban, 4) as iban_ende,
           rz.status as rz_status, rz.fehler as rz_fehler, rz.revolut_transaction_id as rz_tx, rz.aktualisiert_am as rz_am,
           case when rz.status in ('pending', 'completed') then rz.betrag else 0 end as rz_bezahlt,
           coalesce((select sum(x.betrag) from public.revolut_buchungen x, fr
                     where x.notion_fahrer_id = f.notion_fahrer_id and x.state in ('pending', 'completed') and not x.vorschuss
                       and x.id is distinct from rz.revolut_transaction_id
                       and public.buchung_fuer_woche(x.referenz, x.erstellt_am, p_woche, fr.freigegeben_am)), 0) as app,
           (select max(x.erstellt_am) from public.revolut_buchungen x, fr
             where x.notion_fahrer_id = f.notion_fahrer_id and x.state in ('pending', 'completed') and not x.vorschuss
               and public.buchung_fuer_woche(x.referenz, x.erstellt_am, p_woche, fr.freigegeben_am)) as app_am,
           coalesce((select sum(e.betrag) from public.auszahlung_export e where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id
                       and not exists (select 1 from public.revolut_buchungen x where x.referenz = e.referenz
                                         and x.state in ('pending', 'completed'))), 0) as csv,
           (select max(e.exportiert_am) from public.auszahlung_export e where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id) as csv_am,
           coalesce((select sum(ba.betrag) from public.bar_auszahlungen ba
                     where ba.woche = p_woche and ba.notion_fahrer_id = f.notion_fahrer_id and ba.storno_kassabuch_id is null), 0) as bar,
           (select max(ba.ausgezahlt_am) from public.bar_auszahlungen ba
             where ba.woche = p_woche and ba.notion_fahrer_id = f.notion_fahrer_id and ba.storno_kassabuch_id is null) as bar_am
    from z
    join public.fahrer f on f.id = z.fid and f.notion_fahrer_id is not null
    left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id
    left join public.auszahlung_weg aw on aw.woche = p_woche and aw.notion_fahrer_id = f.notion_fahrer_id
    left join public.revolut_zahlungen rz on rz.woche = p_woche and rz.notion_fahrer_id = f.notion_fahrer_id
  ),
  c as (
    select b.*, b.rz_bezahlt + b.app + b.csv as rev, b.rz_bezahlt + b.app + b.csv + b.bar as summe,
           coalesce(b.weg_hand, case when b.geprueft then 'revolut' else 'bar' end) as weg_eff
    from b
  )
  select c.nr, c.fid, c.name, c.zeilen, c.betrag, c.weg_eff, c.weg_hand is not null, c.geprueft,
    case
      when c.betrag < 0 then 'schulden'
      when c.betrag = 0 and c.summe = 0 then 'nichts'
      when c.rz_status in ('reserviert', 'entwurf') then 'entwurf'
      when c.rz_status = 'pending' then 'unterwegs'
      -- Woche gesamt bar ins Kassabuch uebernommen = damals alle bar ausgezahlt (unabhaengig vom heutigen Weg)
      when (select ja from kw) and c.summe = 0 then 'bar_woche'
      when abs(c.summe - c.betrag) <= 0.01 then case when c.bar > 0 and c.bar >= c.rev then 'bar_ok' else 'ueberwiesen' end
      when c.summe > 0 and c.summe < c.betrag then 'rest_offen'
      when c.summe > c.betrag then 'zu_viel'
      when c.weg_eff = 'revolut' then 'revolut_offen'
      else 'bar_offen' end,
    c.summe, greatest(c.betrag - c.summe, 0), c.rev, c.bar,
    greatest(case when c.rz_status in ('pending', 'completed') then c.rz_am end, c.app_am, c.csv_am, c.bar_am),
    c.rz_status, c.rz_fehler, c.iban_ende, (select ja from kw)
  from c
  order by c.name
$$;

-- Buero: Status der Woche
create or replace function public.auszahlung_status(p_woche text)
returns table (notion_fahrer_id integer, fahrer_id integer, name text, zeilen bigint[], betrag numeric, weg text, weg_hand boolean,
               geprueft boolean, status text, bezahlt numeric, offen numeric, bezahlt_revolut numeric, bezahlt_bar numeric,
               zuletzt timestamptz, revolut_status text, revolut_fehler text, iban_ende text, kassa_woche boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  return query select * from public.auszahlung_status_basis(p_woche);
end $$;

-- Weg einer Woche umstellen (nur solange nichts bezahlt und kein Entwurf)
create or replace function public.auszahlung_weg_setzen(p_woche text, p_nr integer, p_weg text)
returns void language plpgsql security definer set search_path = public as $$
declare st record;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_weg not in ('revolut', 'bar') then raise exception 'Weg ist revolut oder bar' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('auszahlung:' || p_woche || ':' || p_nr));
  select * into st from public.auszahlung_status_basis(p_woche) x where x.notion_fahrer_id = p_nr;
  if st.notion_fahrer_id is null then raise exception 'Fahrer Nr. % hat in % keine Abrechnung', p_nr, p_woche using errcode = 'P0002'; end if;
  if st.status not in ('revolut_offen', 'bar_offen') then
    raise exception 'Umstellen geht nur, solange nichts bezahlt ist (jetzt: %)', st.status using errcode = '22023'; end if;
  if p_weg = 'revolut' and not st.geprueft then
    raise exception 'Bankdaten ungeprüft – zuerst im Fahrer-Detail bestätigen' using errcode = '22023'; end if;
  insert into public.auszahlung_weg (woche, notion_fahrer_id, weg, geaendert_von)
  values (p_woche, p_nr, p_weg, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro'))
  on conflict (woche, notion_fahrer_id) do update set weg = excluded.weg, geaendert_von = excluded.geaendert_von, geaendert_am = now();
end $$;

-- Bar ausgezahlt: Betrag = was offen ist (nie aus dem Browser), eine Kassabuch-Ausgabe
create or replace function public.bar_auszahlen(p_woche text, p_nr integer)
returns public.bar_auszahlungen language plpgsql security definer set search_path = public as $$
declare st record; k public.kassabuch; r public.bar_auszahlungen;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if not exists (select 1 from public.abrechnung_freigaben where woche = p_woche) then
    raise exception 'Erst die Woche freigeben' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('auszahlung:' || p_woche || ':' || p_nr));
  select * into st from public.auszahlung_status_basis(p_woche) x where x.notion_fahrer_id = p_nr;
  if st.notion_fahrer_id is null then raise exception 'Fahrer Nr. % hat in % keine Abrechnung', p_nr, p_woche using errcode = 'P0002'; end if;
  if st.kassa_woche then
    raise exception '% steht schon gesamt im Kassabuch – dort ist bar schon gebucht', public.kassa_kw(p_woche) using errcode = '22023'; end if;
  if st.status not in ('bar_offen', 'rest_offen') or st.offen <= 0 then
    raise exception 'Nicht bar auszahlbar (jetzt: %)', st.status using errcode = '22023'; end if;
  k := public.kassa_einfuegen('aus', st.offen, 'Auszahlung ' || public.kassa_kw(p_woche) || ' · ' || st.name ||
         case when st.status = 'rest_offen' then ' (Rest)' else '' end, 'bar', p_woche, null, null);
  insert into public.bar_auszahlungen (woche, notion_fahrer_id, name, betrag, kassabuch_id, ausgezahlt_von)
  values (p_woche, p_nr, st.name, st.offen, k.id, k.name)
  returning * into r;
  return r;
end $$;

-- Rueckgaengig: Gegenbuchung im Kassabuch, die Zeile bleibt (storniert)
create or replace function public.bar_rueckgaengig(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r public.bar_auszahlungen; k public.kassabuch; s public.kassabuch;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into r from public.bar_auszahlungen where id = p_id for update;
  if r.id is null then raise exception 'Bar-Auszahlung nicht gefunden' using errcode = 'P0002'; end if;
  if r.storno_kassabuch_id is not null then raise exception 'Schon rückgängig gemacht' using errcode = '23505'; end if;
  select * into k from public.kassabuch where id = r.kassabuch_id;
  s := public.kassa_einfuegen('ein', r.betrag, 'Storno Nr. ' || k.nr || ' – ' || k.text, 'bar', r.woche, null, k.id);
  update public.bar_auszahlungen set storno_kassabuch_id = s.id, storniert_am = now(), storniert_von = s.name where id = p_id;
end $$;

-- Revolut-Entwurf: nur wer laut Status ueber Revolut offen ist (Betrag = offen). Spalten wie bisher (Edge Function).
create or replace function public.revolut_kandidaten(p_woche text)
returns table (notion_fahrer_id integer, name text, betrag numeric, kontoinhaber text, iban text, bic text, revtag text,
               geprueft boolean, counterparty_id text, counterparty_account_id text, empfaenger text,
               csv_exportiert numeric, zahlung_status text, zahlung_betrag numeric, seit_freigabe_ueberwiesen numeric)
language sql stable security definer set search_path = public as $$
  select st.notion_fahrer_id, st.name, st.offen, fb.kontoinhaber, fb.iban, fb.bic, fb.revtag,
         st.geprueft, fb.revolut_counterparty_id, fb.revolut_counterparty_account_id, fb.revolut_empfaenger,
         0::numeric, rz.status, rz.betrag, 0::numeric
  from public.auszahlung_status_basis(p_woche) st
  join public.fahrer_bank fb on fb.notion_fahrer_id = st.notion_fahrer_id
  left join public.revolut_zahlungen rz on rz.woche = p_woche and rz.notion_fahrer_id = st.notion_fahrer_id
  where st.status = 'revolut_offen'
  order by st.name
$$;

-- Fahrerapp: nur Ueberweisungen der neuesten freigegebenen Woche; bar kommt nicht vor
create or replace function public.fahrer_app_auszahlung(p_fahrer_id integer default null)
returns table (woche text, status text, datum timestamptz, iban_ende text)
language sql stable security definer set search_path = public as $$
  select w.woche, case when st.status = 'entwurf' then 'wird_ueberwiesen' else st.status end, st.zuletzt, st.iban_ende
  from (select public.bank_woche() as woche) w
  cross join lateral public.auszahlung_status_basis(w.woche) st
  join public.fahrer f on f.notion_fahrer_id = st.notion_fahrer_id and f.id = public.fahrer_app_ziel(p_fahrer_id)
  where st.status in ('entwurf', 'unterwegs')
     or (st.status = 'ueberwiesen' and st.bezahlt_bar = 0)
$$;

revoke all on function public.auszahlung_status_basis(text) from public, anon, authenticated;
grant execute on function public.auszahlung_status_basis(text) to service_role;
revoke all on function public.revolut_kandidaten(text) from public, anon, authenticated;
grant execute on function public.revolut_kandidaten(text) to service_role;
revoke all on function public.auszahlung_status(text), public.auszahlung_weg_setzen(text, integer, text),
  public.bar_auszahlen(text, integer), public.bar_rueckgaengig(bigint), public.fahrer_app_auszahlung(integer) from public, anon;
grant execute on function public.auszahlung_status(text), public.auszahlung_weg_setzen(text, integer, text),
  public.bar_auszahlen(text, integer), public.bar_rueckgaengig(bigint), public.fahrer_app_auszahlung(integer) to authenticated;
