-- ============================================================================
-- Ueberweisungshistorie aus Revolut (Serdo), je Fahrer - Dashboard + Fahrerapp
-- Datum: 2026-10-18 (Wunsch Betreiber: "fuer jeden Fahrer eine Ueberweisungshistorie", alles seit Kontoeroeffnung)
--
-- revolut-auszahlung (Aktion buchungen_abrufen, taeglich per Zeitplan) spiegelt alle ausgehenden Ueberweisungen
-- nach revolut_buchungen (Revolut-Transaktions-id = Schluessel, kein doppelter Import).
-- Zuordnung zum Fahrer (revolut_buchungen_zuordnen), in dieser Reihenfolge:
--   1. eigener Entwurf (revolut_zahlungen.revolut_transaction_id)
--   2. Hand-Zuordnung der Gegenpartei durch das Buero (revolut_gegenpartei_zuordnung; Fahrer null = "kein Fahrer")
--   3. Referenz "FHR-<nr>" (Revolut-CSV seit 15.10., Entwuerfe)
--   4. Empfaenger-IBAN = aktuelle oder fruehere IBAN genau eines Fahrers (fahrer_bank + fahrer_bank_verlauf)
--   Sonst bleibt sie offen ("nicht zugeordnet"); geraten wird nicht.
-- Schutz: revolut_kandidaten meldet, was ein Fahrer seit der Freigabe der Woche schon bekommen hat
-- (auch direkt in der Revolut-App ueberwiesen) - dann kein neuer Entwurf.
--
-- Rollback: drop function fahrer_app_ueberweisungen, revolut_gegenpartei_zuordnen, revolut_buchungen_zuordnen;
--   drop view revolut_buchungen_offen; drop table revolut_gegenpartei_zuordnung, revolut_buchungen, revolut_abruf;
--   revolut_kandidaten aus 2026-10-18-revolut-zahlungen.sql neu einspielen.
-- ============================================================================

create table if not exists public.revolut_buchungen (
  id                    text primary key,            -- Revolut-Transaktions-id
  typ                   text,
  state                 text,
  erstellt_am           timestamptz not null,
  abgeschlossen_am      timestamptz,
  konto_id              text,
  betrag                numeric(12,2) not null,      -- ausgezahlt, positiv
  waehrung              text,
  referenz              text,
  beschreibung          text,
  gegen_counterparty_id text,
  gegen_account_id      text,
  gegen_name            text,
  gegen_iban            text,
  notion_fahrer_id      integer,
  zuordnung             text check (zuordnung is null or zuordnung in ('entwurf', 'hand', 'referenz', 'iban')),
  aktualisiert_am       timestamptz not null default now()
);
create index if not exists revolut_buchungen_fahrer on public.revolut_buchungen (notion_fahrer_id, erstellt_am desc);
create index if not exists revolut_buchungen_offen_idx on public.revolut_buchungen (erstellt_am desc) where zuordnung is null;

-- Hand-Zuordnung je Gegenpartei (gilt fuer alle ihre Buchungen, auch kuenftige)
create table if not exists public.revolut_gegenpartei_zuordnung (
  schluessel       text primary key,     -- cp:<counterparty-id> | iban:<IBAN> | name:<name>
  notion_fahrer_id integer,              -- null = kein Fahrer (z. B. Lieferant)
  zugeordnet_von   text not null,
  zugeordnet_am    timestamptz not null default now()
);

-- Stand des Abrufs (erster Abruf holt die Historie seitenweise von neu nach alt, ueber mehrere Laeufe)
create table if not exists public.revolut_abruf (
  id            integer primary key default 1 check (id = 1),
  historie_fertig boolean not null default false,
  aeltestes     timestamptz,
  letzter_lauf  timestamptz,
  letzter_fehler text,
  anzahl        integer
);
insert into public.revolut_abruf (id) values (1) on conflict do nothing;

alter table public.revolut_buchungen enable row level security;
alter table public.revolut_gegenpartei_zuordnung enable row level security;
alter table public.revolut_abruf enable row level security;
revoke all on public.revolut_buchungen, public.revolut_gegenpartei_zuordnung, public.revolut_abruf from public, anon, authenticated;
grant select on public.revolut_buchungen, public.revolut_gegenpartei_zuordnung, public.revolut_abruf to authenticated;
drop policy if exists buero_liest on public.revolut_buchungen;
drop policy if exists buero_liest on public.revolut_gegenpartei_zuordnung;
drop policy if exists buero_liest on public.revolut_abruf;
create policy buero_liest on public.revolut_buchungen for select to authenticated using (public.is_app_user());
create policy buero_liest on public.revolut_gegenpartei_zuordnung for select to authenticated using (public.is_app_user());
create policy buero_liest on public.revolut_abruf for select to authenticated using (public.is_app_user());

drop trigger if exists protokoll_mitschreiben on public.revolut_gegenpartei_zuordnung;
create trigger protokoll_mitschreiben after insert or update or delete on public.revolut_gegenpartei_zuordnung
  for each row execute function public.protokoll_schreiben('schluessel', 'ohne', '', '');

create or replace function public.revolut_gegen_schluessel(p_cp text, p_iban text, p_name text) returns text
language sql immutable set search_path = public as $$
  select coalesce('cp:' || nullif(p_cp, ''), 'iban:' || nullif(p_iban, ''), 'name:' || nullif(lower(btrim(p_name)), ''), 'unbekannt')
$$;

-- Zuordnung neu rechnen (ausser Hand-Zuordnung, die gewinnt immer). Liefert die Zahl offener Buchungen.
create or replace function public.revolut_buchungen_zuordnen() returns integer
language plpgsql security definer set search_path = public as $$
declare v_offen integer;
begin
  with ib as (   -- jede IBAN, die genau einem Fahrer gehoert(e)
    select iban, min(nr) as nr from (
      select iban, notion_fahrer_id as nr from public.fahrer_bank
      union select neu_iban, notion_fahrer_id from public.fahrer_bank_verlauf
      union select alt_iban, notion_fahrer_id from public.fahrer_bank_verlauf where alt_iban is not null
    ) x group by iban having count(distinct nr) = 1
  ),
  nrs as (select notion_fahrer_id as nr from public.notion_fahrer where notion_fahrer_id is not null
          union select notion_fahrer_id from public.fahrer where notion_fahrer_id is not null),
  neu as (
    select b.id,
      case when rz.notion_fahrer_id is not null then rz.notion_fahrer_id
           when h.schluessel is not null then h.notion_fahrer_id
           when ref.nr is not null then ref.nr
           else ib.nr end as nr,
      case when rz.notion_fahrer_id is not null then 'entwurf'
           when h.schluessel is not null then 'hand'
           when ref.nr is not null then 'referenz'
           when ib.nr is not null then 'iban' end as art
    from public.revolut_buchungen b
    left join public.revolut_zahlungen rz on rz.revolut_transaction_id = b.id
    left join public.revolut_gegenpartei_zuordnung h
      on h.schluessel = public.revolut_gegen_schluessel(b.gegen_counterparty_id, b.gegen_iban, b.gegen_name)
    left join lateral (select n.nr from nrs n where n.nr = (substring(b.referenz from 'FHR-(\d{1,9})'))::integer) ref on true
    left join ib on ib.iban = b.gegen_iban
  )
  update public.revolut_buchungen b set notion_fahrer_id = neu.nr, zuordnung = neu.art
    from neu where neu.id = b.id
      and (b.notion_fahrer_id is distinct from neu.nr or b.zuordnung is distinct from neu.art);
  select count(*) into v_offen from public.revolut_buchungen where zuordnung is null;
  return v_offen;
end $$;

-- Buero ordnet eine Gegenpartei (alle ihre Buchungen) einem Fahrer zu, oder "kein Fahrer" (p_nr null)
create or replace function public.revolut_gegenpartei_zuordnen(p_schluessel text, p_nr integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_schluessel is null or p_schluessel !~ '^(cp|iban|name):' then raise exception 'Gegenpartei fehlt' using errcode = '22023'; end if;
  if p_nr is not null and not exists (select 1 from public.notion_fahrer where notion_fahrer_id = p_nr)
     and not exists (select 1 from public.fahrer where notion_fahrer_id = p_nr) then
    raise exception 'Kein Fahrer mit Nr. %', p_nr using errcode = 'P0002'; end if;
  insert into public.revolut_gegenpartei_zuordnung (schluessel, notion_fahrer_id, zugeordnet_von)
  values (p_schluessel, p_nr, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro'))
  on conflict (schluessel) do update set notion_fahrer_id = excluded.notion_fahrer_id,
    zugeordnet_von = excluded.zugeordnet_von, zugeordnet_am = now();
  return public.revolut_buchungen_zuordnen();
end $$;

-- Dashboard: nicht zugeordnete Ueberweisungen, je Gegenpartei zusammengefasst
create or replace view public.revolut_buchungen_offen with (security_invoker = true) as
select public.revolut_gegen_schluessel(gegen_counterparty_id, gegen_iban, gegen_name) as schluessel,
       max(gegen_name) as name, max(gegen_iban) as iban, count(*)::integer as anzahl, sum(betrag) as summe,
       max(erstellt_am) as letzte, (array_agg(referenz order by erstellt_am desc))[1] as letzte_referenz
from public.revolut_buchungen
where zuordnung is null
group by 1;
revoke all on public.revolut_buchungen_offen from public, anon;
grant select on public.revolut_buchungen_offen to authenticated;

-- Fahrerapp: eigene Ueberweisungen (Buero-Vorschau mit p_fahrer_id). Ohne IBAN, nur Ende.
create or replace function public.fahrer_app_ueberweisungen(p_fahrer_id integer default null)
returns table (datum timestamptz, betrag numeric, referenz text, status text, iban_ende text)
language sql stable security definer set search_path = public as $$
  select coalesce(b.abgeschlossen_am, b.erstellt_am), b.betrag, b.referenz, b.state, right(b.gegen_iban, 4)
  from public.fahrer f
  join public.revolut_buchungen b on b.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id) and f.notion_fahrer_id is not null
  order by b.erstellt_am desc
  limit 200
$$;

-- Kandidaten fuer den Entwurf: zusaetzlich, was seit der Freigabe der Woche schon ueberwiesen wurde
drop function if exists public.revolut_kandidaten(text);
create function public.revolut_kandidaten(p_woche text)
returns table (notion_fahrer_id integer, name text, betrag numeric, kontoinhaber text, iban text, bic text, revtag text,
               geprueft boolean, counterparty_id text, counterparty_account_id text, empfaenger text,
               csv_exportiert numeric, zahlung_status text, zahlung_betrag numeric, seit_freigabe_ueberwiesen numeric)
language sql stable security definer set search_path = public as $$
  with fr as (select freigegeben_am from public.abrechnung_freigaben where woche = p_woche),
  z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)) as betrag
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
      and exists (select 1 from fr)
    group by 1
  )
  select f.notion_fahrer_id, f.name, round(z.betrag, 2), fb.kontoinhaber, fb.iban, fb.bic, fb.revtag,
         coalesce(fb.geprueft, false), fb.revolut_counterparty_id, fb.revolut_counterparty_account_id, fb.revolut_empfaenger,
         coalesce((select sum(e.betrag) from public.auszahlung_export e
                   where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id), 0),
         rz.status, rz.betrag,
         coalesce((select sum(b.betrag) from public.revolut_buchungen b, fr
                   where b.notion_fahrer_id = f.notion_fahrer_id and b.state in ('pending', 'completed')
                     and b.erstellt_am >= fr.freigegeben_am
                     and b.id is distinct from rz.revolut_transaction_id
                     -- nennt die Referenz ausdruecklich eine andere KW (z. B. Vorwoche spaet ueberwiesen), zaehlt sie nicht
                     and coalesce((substring(upper(b.referenz) from 'KW ?0*(\d{1,2})'))::integer,
                                  (substring(p_woche from 'W(\d{2})'))::integer) = (substring(p_woche from 'W(\d{2})'))::integer), 0)
  from z
  join public.fahrer f on f.id = z.fid and f.notion_fahrer_id is not null
  left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id
  left join public.revolut_zahlungen rz on rz.woche = p_woche and rz.notion_fahrer_id = f.notion_fahrer_id
  order by f.name
$$;

revoke all on function public.revolut_kandidaten(text), public.revolut_buchungen_zuordnen(),
  public.revolut_gegen_schluessel(text, text, text) from public, anon, authenticated;
grant execute on function public.revolut_kandidaten(text), public.revolut_buchungen_zuordnen() to service_role;
grant execute on function public.revolut_gegen_schluessel(text, text, text) to service_role, authenticated;
revoke all on function public.revolut_gegenpartei_zuordnen(text, integer), public.fahrer_app_ueberweisungen(integer) from public, anon;
grant execute on function public.revolut_gegenpartei_zuordnen(text, integer), public.fahrer_app_ueberweisungen(integer) to authenticated;
