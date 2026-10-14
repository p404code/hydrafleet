-- ============================================================================
-- Bankdaten der Fahrer (Teil A der Spec docs/superpowers/specs/2026-10-15-iban-fahrerapp-design.md)
-- Datum: 2026-10-15
--
-- Fahrer tragen ihre IBAN in der Fahrerapp ein und bestaetigen sie je Woche.
-- Lesen: nur Buero (RLS). Schreiben: nur ueber die RPCs unten.
-- Eine neue IBAN gilt sofort (Entscheidung Betreiber 13.10.) - deshalb wird jede
-- Aenderung unveraenderlich in fahrer_bank_verlauf festgehalten.
-- Schluessel ist die Notion-Fahrer-Nr. (bleibt, wenn n8n die fahrer-Zeile neu anlegt).
--
-- Rollback: drop view bank_uebersicht; drop function fahrer_app_bank, fahrer_bank_setzen,
--   bank_bestaetigen, buero_bank_setzen, bank_schreiben, bank_betrag, bank_woche, iban_gueltig,
--   iban_norm, bank_verlauf_gesperrt; drop table bank_bestaetigung, fahrer_bank_verlauf, fahrer_bank;
-- ============================================================================

create or replace function public.iban_norm(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- Gleiche Regeln wie bank-logik.js: Laenge je Land (sonst 15-34), Pruefziffer mod 97 = 1.
create or replace function public.iban_gueltig(p text) returns boolean
language plpgsql immutable as $$
declare i text := public.iban_norm(p); soll int; r text; d text := ''; c text; k int;
begin
  if i !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return false; end if;
  soll := case substr(i, 1, 2)
    when 'AT' then 20 when 'BE' then 16 when 'BG' then 22 when 'CH' then 21 when 'CY' then 28 when 'CZ' then 24
    when 'DE' then 22 when 'DK' then 18 when 'EE' then 20 when 'ES' then 24 when 'FI' then 18 when 'FR' then 27
    when 'GB' then 22 when 'GR' then 27 when 'HR' then 21 when 'HU' then 28 when 'IE' then 22 when 'IS' then 26
    when 'IT' then 27 when 'LI' then 21 when 'LT' then 20 when 'LU' then 20 when 'LV' then 21 when 'MT' then 31
    when 'NL' then 18 when 'NO' then 15 when 'PL' then 28 when 'PT' then 25 when 'RO' then 24 when 'SE' then 24
    when 'SI' then 19 when 'SK' then 24 when 'TR' then 26 when 'RS' then 22 when 'BA' then 20 when 'MK' then 19
    when 'AL' then 28 when 'XK' then 20 when 'ME' then 22 when 'UA' then 29 when 'GE' then 22 when 'AZ' then 28
    else null end;
  if soll is not null and length(i) <> soll then return false; end if;
  r := substr(i, 5) || substr(i, 1, 4);
  for k in 1..length(r) loop
    c := substr(r, k, 1);
    d := d || case when c ~ '[0-9]' then c else (ascii(c) - 55)::text end;
  end loop;
  return mod(d::numeric, 97) = 1;
end $$;

create table if not exists public.fahrer_bank (
  notion_fahrer_id integer primary key,
  kontoinhaber     text not null check (length(kontoinhaber) between 2 and 140),
  iban             text not null check (iban = public.iban_norm(iban) and public.iban_gueltig(iban)),
  bic              text check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  revtag           text check (revtag is null or revtag ~ '^@[A-Za-z0-9._-]{2,40}$'),
  geaendert_am     timestamptz not null default now(),
  geaendert_von    text not null
);

create table if not exists public.fahrer_bank_verlauf (
  id               bigint generated always as identity primary key,
  notion_fahrer_id integer not null,
  zeit             timestamptz not null default now(),
  von              text not null,
  alt_kontoinhaber text, alt_iban text, alt_bic text, alt_revtag text,
  neu_kontoinhaber text not null, neu_iban text not null, neu_bic text, neu_revtag text
);
create index if not exists fahrer_bank_verlauf_nr on public.fahrer_bank_verlauf (notion_fahrer_id, zeit);

create or replace function public.bank_verlauf_gesperrt() returns trigger language plpgsql as $$
begin
  raise exception 'Der Bankdaten-Verlauf wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists bank_verlauf_gesperrt on public.fahrer_bank_verlauf;
create trigger bank_verlauf_gesperrt before update or delete on public.fahrer_bank_verlauf
  for each row execute function public.bank_verlauf_gesperrt();

create table if not exists public.bank_bestaetigung (
  woche            text not null,
  notion_fahrer_id integer not null,
  iban             text not null,
  kontoinhaber     text not null,
  betrag           numeric(10,2) not null,
  bestaetigt_am    timestamptz not null default now(),
  primary key (woche, notion_fahrer_id)
);

alter table public.fahrer_bank enable row level security;
alter table public.fahrer_bank_verlauf enable row level security;
alter table public.bank_bestaetigung enable row level security;
revoke all on public.fahrer_bank, public.fahrer_bank_verlauf, public.bank_bestaetigung from public, anon, authenticated;
grant select on public.fahrer_bank, public.fahrer_bank_verlauf, public.bank_bestaetigung to authenticated;
drop policy if exists buero_liest on public.fahrer_bank;
drop policy if exists buero_liest on public.fahrer_bank_verlauf;
drop policy if exists buero_liest on public.bank_bestaetigung;
create policy buero_liest on public.fahrer_bank for select to authenticated using (public.is_app_user());
create policy buero_liest on public.fahrer_bank_verlauf for select to authenticated using (public.is_app_user());
create policy buero_liest on public.bank_bestaetigung for select to authenticated using (public.is_app_user());

-- Protokoll (wer hat was geaendert) wie die anderen 12 Tabellen
drop trigger if exists protokoll_mitschreiben on public.fahrer_bank;
create trigger protokoll_mitschreiben after insert or update or delete on public.fahrer_bank
  for each row execute function public.protokoll_schreiben('notion_fahrer_id', 'ohne', '', '');
drop trigger if exists protokoll_mitschreiben on public.bank_bestaetigung;
create trigger protokoll_mitschreiben after insert or update or delete on public.bank_bestaetigung
  for each row execute function public.protokoll_schreiben('woche,notion_fahrer_id', 'ohne', '', '');

-- Neueste freigegebene Woche (2026-W37k zaehlt als W36 wie in fahrer_app_abrechnungen)
create or replace function public.bank_woche() returns text
language sql stable security definer set search_path = public as $$
  select fr.woche from public.abrechnung_freigaben fr
  order by case fr.woche when '2026-W37k' then '2026-W36' else fr.woche end desc limit 1
$$;

-- "Du bekommst" eines Fahrers in einer Woche, ueber alle seine Zeilen (Alias-Fall). null = keine Zeile.
create or replace function public.bank_betrag(p_fahrer_id integer, p_woche text) returns numeric
language sql stable security definer set search_path = public as $$
  select sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0))
  from public.settlements s
  where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    and public.settlement_fahrer(s.telefon, s.fahrer_name) = p_fahrer_id
$$;

-- Einzige Stelle, die fahrer_bank schreibt. Nicht direkt aufrufbar (siehe revoke unten).
create or replace function public.bank_schreiben(p_nr integer, p_kontoinhaber text, p_iban text,
                                                 p_bic text, p_revtag text, p_von text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_iban text := public.iban_norm(p_iban);
  v_inh  text := regexp_replace(btrim(coalesce(p_kontoinhaber, '')), '\s+', ' ', 'g');
  v_bic  text := nullif(public.iban_norm(p_bic), '');
  v_rev  text := nullif(btrim(coalesce(p_revtag, '')), '');
  a public.fahrer_bank; v_war boolean;
begin
  if p_nr is null then raise exception 'Fahrer-Nr. fehlt' using errcode = '22023'; end if;
  if length(v_inh) < 2 or length(v_inh) > 140 then raise exception 'Kontoinhaber fehlt' using errcode = '22023'; end if;
  if not public.iban_gueltig(v_iban) then raise exception 'IBAN ungültig – bitte prüfen' using errcode = '22023'; end if;
  if v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    raise exception 'BIC ungültig (8 oder 11 Zeichen)' using errcode = '22023'; end if;
  if v_rev is not null then
    if v_rev !~ '^@?[A-Za-z0-9._-]{2,40}$' then raise exception 'Revtag ungültig, z. B. @deinname' using errcode = '22023'; end if;
    if left(v_rev, 1) <> '@' then v_rev := '@' || v_rev; end if;
  end if;

  select * into a from public.fahrer_bank where notion_fahrer_id = p_nr for update;
  v_war := a.notion_fahrer_id is not null;
  if v_war and a.kontoinhaber = v_inh and a.iban = v_iban
     and a.bic is not distinct from v_bic and a.revtag is not distinct from v_rev then
    return;   -- nichts geaendert: kein Verlauf, Bestaetigung bleibt
  end if;

  insert into public.fahrer_bank_verlauf (notion_fahrer_id, von, alt_kontoinhaber, alt_iban, alt_bic, alt_revtag,
                                          neu_kontoinhaber, neu_iban, neu_bic, neu_revtag)
  values (p_nr, p_von, a.kontoinhaber, a.iban, a.bic, a.revtag, v_inh, v_iban, v_bic, v_rev);

  insert into public.fahrer_bank (notion_fahrer_id, kontoinhaber, iban, bic, revtag, geaendert_am, geaendert_von)
  values (p_nr, v_inh, v_iban, v_bic, v_rev, now(), p_von)
  on conflict (notion_fahrer_id) do update
    set kontoinhaber = excluded.kontoinhaber, iban = excluded.iban, bic = excluded.bic, revtag = excluded.revtag,
        geaendert_am = now(), geaendert_von = excluded.geaendert_von;

  -- Bestaetigt ist immer genau eine IBAN: Ziel geaendert -> offene Woche neu bestaetigen
  if v_war and (a.iban <> v_iban or a.kontoinhaber <> v_inh) then
    delete from public.bank_bestaetigung where notion_fahrer_id = p_nr and woche = public.bank_woche();
  end if;
end $$;

-- Fahrerapp: eigene Bankdaten + Stand der neuesten freigegebenen Woche (Buero-Vorschau mit p_fahrer_id)
create or replace function public.fahrer_app_bank(p_fahrer_id integer default null)
returns table (kontoinhaber text, iban text, bic text, revtag text, geaendert_am timestamptz,
               woche text, betrag numeric, bestaetigt_am timestamptz, bestaetigt_iban text)
language sql stable security definer set search_path = public as $$
  with z as (select f.id, f.notion_fahrer_id as nr from public.fahrer f where f.id = public.fahrer_app_ziel(p_fahrer_id)),
       w as (select public.bank_woche() as woche)
  select b.kontoinhaber, b.iban, b.bic, b.revtag, b.geaendert_am,
         w.woche, public.bank_betrag(z.id, w.woche), bb.bestaetigt_am, bb.iban
  from z cross join w
  left join public.fahrer_bank b on b.notion_fahrer_id = z.nr
  left join public.bank_bestaetigung bb on bb.notion_fahrer_id = z.nr and bb.woche = w.woche
  where z.nr is not null
$$;

-- Fahrer setzt seine Bankdaten (gilt sofort). Buero/Vorschau: abgelehnt.
create or replace function public.fahrer_bank_setzen(p_kontoinhaber text, p_iban text,
                                                     p_bic text default null, p_revtag text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_id integer := public.mein_fahrer_id(); v_nr integer;
begin
  if v_id is null then raise exception 'Nur in der Fahrerapp möglich' using errcode = '42501'; end if;
  select notion_fahrer_id into v_nr from public.fahrer where id = v_id;
  perform public.bank_schreiben(v_nr, p_kontoinhaber, p_iban, p_bic, p_revtag, 'fahrer');
end $$;

-- Fahrer bestaetigt seine IBAN fuer die neueste freigegebene Woche. p_iban = die IBAN, die er auf der
-- Karte gesehen hat: wurde sie inzwischen geaendert (Buero, zweites Handy), wird nichts bestaetigt.
drop function if exists public.bank_bestaetigen(text);
create or replace function public.bank_bestaetigen(p_woche text, p_iban text)
returns void language plpgsql security definer set search_path = public as $$
declare v_id integer := public.mein_fahrer_id(); v_nr integer; b public.fahrer_bank; v_betrag numeric;
begin
  if v_id is null then raise exception 'Nur in der Fahrerapp möglich' using errcode = '42501'; end if;
  if p_woche is distinct from public.bank_woche() then
    raise exception 'Nur die aktuelle Woche kann bestätigt werden' using errcode = '22023'; end if;
  select notion_fahrer_id into v_nr from public.fahrer where id = v_id;
  select * into b from public.fahrer_bank where notion_fahrer_id = v_nr for update;
  if b.notion_fahrer_id is null then raise exception 'Bitte zuerst Bankdaten eintragen' using errcode = '22023'; end if;
  if b.iban is distinct from public.iban_norm(p_iban) then
    raise exception 'Deine IBAN wurde inzwischen geändert – bitte neu prüfen' using errcode = '22023'; end if;
  v_betrag := public.bank_betrag(v_id, p_woche);
  if coalesce(v_betrag, 0) <= 0 then raise exception 'Für diese Woche gibt es keine Auszahlung' using errcode = '22023'; end if;
  insert into public.bank_bestaetigung (woche, notion_fahrer_id, iban, kontoinhaber, betrag)
  values (p_woche, v_nr, b.iban, b.kontoinhaber, round(v_betrag, 2))
  on conflict (woche, notion_fahrer_id) do update
    set iban = excluded.iban, kontoinhaber = excluded.kontoinhaber, betrag = excluded.betrag, bestaetigt_am = now();
end $$;

-- Buero traegt Bankdaten fuer einen Fahrer ein (z. B. Uebernahme). Bestaetigen kann nur der Fahrer.
create or replace function public.buero_bank_setzen(p_notion_fahrer_id integer, p_kontoinhaber text, p_iban text,
                                                    p_bic text default null, p_revtag text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein aktiver Fahrer mit Nr. %', p_notion_fahrer_id using errcode = 'P0002'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, p_kontoinhaber, p_iban, p_bic, p_revtag,
                                coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro'));
end $$;

-- Dashboard: je aktivem Fahrer Bankdaten + Bestaetigung der neuesten Woche
create or replace view public.bank_uebersicht with (security_invoker = true) as
select f.id as fahrer_id, f.notion_fahrer_id, f.name,
       b.kontoinhaber, b.iban, b.bic, b.revtag, b.geaendert_am, b.geaendert_von,
       w.woche, bb.bestaetigt_am, bb.iban as bestaetigt_iban, bb.betrag as bestaetigt_betrag,
       (select count(*) from public.fahrer_bank_verlauf v where v.notion_fahrer_id = f.notion_fahrer_id)::integer as aenderungen
from public.fahrer f
cross join (select public.bank_woche() as woche) w
left join public.fahrer_bank b on b.notion_fahrer_id = f.notion_fahrer_id
left join public.bank_bestaetigung bb on bb.notion_fahrer_id = f.notion_fahrer_id and bb.woche = w.woche
where f.aktiv and f.notion_fahrer_id is not null;
revoke all on public.bank_uebersicht from public, anon;
grant select on public.bank_uebersicht to authenticated;

-- bank_schreiben und bank_betrag nur intern (ueber die security-definer-RPCs): sonst koennte ein
-- Fahrer mit bank_betrag(<fremde id>, woche) die Auszahlung eines anderen abfragen.
revoke all on function public.bank_schreiben(integer, text, text, text, text, text),
  public.bank_betrag(integer, text) from public, anon, authenticated;
revoke all on function public.fahrer_app_bank(integer), public.fahrer_bank_setzen(text, text, text, text),
  public.bank_bestaetigen(text, text), public.buero_bank_setzen(integer, text, text, text, text),
  public.bank_woche() from public, anon;
grant execute on function public.fahrer_app_bank(integer), public.fahrer_bank_setzen(text, text, text, text),
  public.bank_bestaetigen(text, text), public.buero_bank_setzen(integer, text, text, text, text),
  public.bank_woche() to authenticated;
