-- ============================================================================
-- Bankdaten: Buero-Pruefung statt Wochen-Bestaetigung (Vorbereitung Revolut-API)
-- Datum: 2026-10-18
--
-- Entscheidung Betreiber 18.10.2026: Die Wochen-Bestaetigung durch den Fahrer wird nicht mehr abgefragt.
-- Stattdessen prueft das Buero die Bankdaten einmal (fahrer_bank.geprueft). Jede Aenderung - egal von wem -
-- setzt die Pruefung und die Revolut-Gegenpartei zurueck. Die IBAN bleibt in der App aenderbar.
-- Die Fahrerapp bekommt die IBAN nur noch maskiert (LT•• •••• •••• •••• 9859).
-- Bestand: wer seine aktuelle IBAN + Kontoinhaber schon fuer eine Woche bestaetigt hat, gilt als geprueft.
-- bank_bestaetigung bleibt als Verlauf stehen, wird aber nicht mehr geschrieben.
--
-- Rollback: alter table fahrer_bank drop column geprueft, geprueft_am, geprueft_von, revolut_counterparty_id;
--   drop function bank_pruefen, iban_maskiert; 2026-10-15-bankdaten.sql + -auszahlung-export.sql neu einspielen.
-- ============================================================================

alter table public.fahrer_bank add column if not exists geprueft boolean not null default false;
alter table public.fahrer_bank add column if not exists geprueft_am timestamptz;
alter table public.fahrer_bank add column if not exists geprueft_von text;
alter table public.fahrer_bank add column if not exists revolut_counterparty_id text;   -- Teil 2 (Revolut-API)

-- Uebernahme: aktuelle IBAN + Inhaber vom Fahrer schon bestaetigt -> geprueft (einmalig, nur wo noch offen)
update public.fahrer_bank fb
   set geprueft = true, geprueft_am = bb.bestaetigt_am, geprueft_von = 'Fahrer-Bestätigung (Übernahme 18.10.)'
  from (select distinct on (notion_fahrer_id) notion_fahrer_id, iban, kontoinhaber, bestaetigt_am
          from public.bank_bestaetigung order by notion_fahrer_id, bestaetigt_am desc) bb
 where bb.notion_fahrer_id = fb.notion_fahrer_id and not fb.geprueft
   and bb.iban = fb.iban and bb.kontoinhaber = fb.kontoinhaber;

-- LT12 1000 0111 0100 1000 -> LT•• •••• •••• •••• 1000
create or replace function public.iban_maskiert(p text) returns text
language sql immutable as $$
  select case when length(i) > 8
              then regexp_replace(left(i, 2) || repeat('•', length(i) - 6) || right(i, 4), '(.{4})(?=.)', '\1 ', 'g')
              else i end
  from (select public.iban_norm(p) as i) x
$$;

-- Einzige Stelle, die fahrer_bank schreibt (wie 2026-10-15, plus Ruecksetzen von Pruefung und Gegenpartei).
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
    return;   -- nichts geaendert: kein Verlauf, Pruefung bleibt
  end if;

  insert into public.fahrer_bank_verlauf (notion_fahrer_id, von, alt_kontoinhaber, alt_iban, alt_bic, alt_revtag,
                                          neu_kontoinhaber, neu_iban, neu_bic, neu_revtag)
  values (p_nr, p_von, a.kontoinhaber, a.iban, a.bic, a.revtag, v_inh, v_iban, v_bic, v_rev);

  -- Jede Aenderung: Buero muss neu pruefen, Revolut braucht eine neue Gegenpartei
  insert into public.fahrer_bank (notion_fahrer_id, kontoinhaber, iban, bic, revtag, geaendert_am, geaendert_von)
  values (p_nr, v_inh, v_iban, v_bic, v_rev, now(), p_von)
  on conflict (notion_fahrer_id) do update
    set kontoinhaber = excluded.kontoinhaber, iban = excluded.iban, bic = excluded.bic, revtag = excluded.revtag,
        geaendert_am = now(), geaendert_von = excluded.geaendert_von,
        geprueft = false, geprueft_am = null, geprueft_von = null, revolut_counterparty_id = null;
end $$;

-- Fahrerapp: eigene Bankdaten, IBAN nur maskiert (Buero-Vorschau mit p_fahrer_id ebenso)
drop function if exists public.fahrer_app_bank(integer);
create function public.fahrer_app_bank(p_fahrer_id integer default null)
returns table (kontoinhaber text, iban text, bic text, revtag text, geaendert_am timestamptz, geprueft boolean)
language sql stable security definer set search_path = public as $$
  select b.kontoinhaber, public.iban_maskiert(b.iban), b.bic, b.revtag, b.geaendert_am, coalesce(b.geprueft, false)
  from public.fahrer f
  left join public.fahrer_bank b on b.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id) and f.notion_fahrer_id is not null
$$;

-- Buero bestaetigt die Bankdaten. p_iban = die IBAN, die es gesehen hat: inzwischen geaendert -> nichts.
create or replace function public.bank_pruefen(p_notion_fahrer_id integer, p_iban text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.fahrer_bank;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into b from public.fahrer_bank where notion_fahrer_id = p_notion_fahrer_id for update;
  if b.notion_fahrer_id is null then raise exception 'Keine Bankdaten hinterlegt' using errcode = 'P0002'; end if;
  if b.iban is distinct from public.iban_norm(p_iban) then
    raise exception 'Die IBAN wurde inzwischen geändert – bitte neu laden und erneut prüfen' using errcode = '22023'; end if;
  if b.geprueft then return; end if;
  update public.fahrer_bank
     set geprueft = true, geprueft_am = now(), geprueft_von = coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro')
   where notion_fahrer_id = p_notion_fahrer_id;
end $$;

-- Dashboard: neue Spalten hinten anhaengen (create or replace view erlaubt nur das).
-- iban_geaendert_am = letzter echter IBAN-Wechsel (nicht die Ersteintragung) -> Hinweis "in den letzten 14 Tagen".
create or replace view public.bank_uebersicht with (security_invoker = true) as
select f.id as fahrer_id, f.notion_fahrer_id, f.name,
       b.kontoinhaber, b.iban, b.bic, b.revtag, b.geaendert_am, b.geaendert_von,
       w.woche, bb.bestaetigt_am, bb.iban as bestaetigt_iban, bb.betrag as bestaetigt_betrag,
       (select count(*) from public.fahrer_bank_verlauf v where v.notion_fahrer_id = f.notion_fahrer_id)::integer as aenderungen,
       coalesce(b.geprueft, false) as geprueft, b.geprueft_am, b.geprueft_von,
       (select max(v.zeit) from public.fahrer_bank_verlauf v
         where v.notion_fahrer_id = f.notion_fahrer_id and v.alt_iban is not null and v.alt_iban <> v.neu_iban) as iban_geaendert_am
from public.fahrer f
cross join (select public.bank_woche() as woche) w
left join public.fahrer_bank b on b.notion_fahrer_id = f.notion_fahrer_id
left join public.bank_bestaetigung bb on bb.notion_fahrer_id = f.notion_fahrer_id and bb.woche = w.woche
where f.aktiv and f.notion_fahrer_id is not null;

-- Revolut-CSV: IBAN/Inhaber immer aus fahrer_bank; "bestaetigt" heisst jetzt "vom Buero geprueft".
create or replace function public.auszahlung_liste(p_woche text)
returns table (fahrer_id integer, notion_fahrer_id integer, name text, du_bekommst numeric,
               iban text, kontoinhaber text, bestaetigt boolean, bestaetigt_am timestamptz, hat_iban boolean, exportiert numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  return query
  with z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)) as betrag
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    group by 1
  )
  select f.id, f.notion_fahrer_id, f.name, round(z.betrag, 2), fb.iban, fb.kontoinhaber,
         coalesce(fb.geprueft, false), fb.geprueft_am,
         fb.notion_fahrer_id is not null,
         coalesce((select sum(e.betrag) from public.auszahlung_export e
                   where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id), 0)
  from z
  join public.fahrer f on f.id = z.fid
  left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id;
end $$;

create or replace function public.auszahlung_export_speichern(p_woche text, p_posten jsonb, p_nochmal boolean default false)
returns table (name text, iban text, land text, betrag numeric, referenz text, bestaetigt boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r record; fb public.fahrer_bank; v_best boolean;
  v_betrag numeric; v_ref text; v_name text;
  v_lauf uuid := gen_random_uuid();
  v_von text := coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro');
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_posten is null or jsonb_typeof(p_posten) <> 'array' or jsonb_array_length(p_posten) = 0 then
    raise exception 'Keine Fahrer ausgewählt' using errcode = '22023'; end if;
  for r in select (e->>'nr')::integer as nr, (e->>'betrag')::numeric as betrag from jsonb_array_elements(p_posten) e loop
    v_betrag := round(r.betrag, 2);
    if v_betrag is null or v_betrag <= 0 or v_betrag > 20000 then
      raise exception 'Betrag für Fahrer Nr. % muss zwischen 0 und 20.000 € liegen', r.nr using errcode = '22023'; end if;
    select * into fb from public.fahrer_bank b where b.notion_fahrer_id = r.nr;
    if fb.iban is null then
      raise exception 'Fahrer Nr. % hat keine IBAN hinterlegt', r.nr using errcode = '22023'; end if;
    v_best := fb.geprueft;
    if not coalesce(p_nochmal, false) and exists (select 1 from public.auszahlung_export e
                                                 where e.woche = p_woche and e.notion_fahrer_id = r.nr) then
      raise exception 'Fahrer Nr. % ist für % schon exportiert', r.nr, p_woche using errcode = 'P0001'; end if;
    select f.name into v_name from public.fahrer f where f.notion_fahrer_id = r.nr and f.aktiv limit 1;
    v_ref := 'Auszahlung KW' || coalesce(ltrim(substring(p_woche from 'W(\d+)'), '0'), '') || ' FHR-' || r.nr;
    insert into public.auszahlung_export (lauf, woche, notion_fahrer_id, name, iban, kontoinhaber, betrag, referenz, exportiert_von, bestaetigt)
    values (v_lauf, p_woche, r.nr, coalesce(v_name, fb.kontoinhaber), fb.iban, fb.kontoinhaber, v_betrag, v_ref, v_von, v_best);
    name := fb.kontoinhaber; iban := fb.iban; land := left(fb.iban, 2); betrag := v_betrag; referenz := v_ref; bestaetigt := v_best;
    return next;
  end loop;
end $$;

-- Rechte: Wochen-Bestaetigung abgeschaltet (Funktion bleibt fuer den Rollback stehen)
revoke all on function public.bank_bestaetigen(text, text) from public, anon, authenticated;
revoke all on function public.fahrer_app_bank(integer), public.bank_pruefen(integer, text) from public, anon;
grant execute on function public.fahrer_app_bank(integer), public.bank_pruefen(integer, text) to authenticated;

-- Advisor: fester search_path
alter function public.iban_maskiert(text) set search_path = public;
