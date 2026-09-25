-- 2026-W37k enthaelt die Umsaetze von KW36 (docs/2026-09-23-datenpruefung.md).
-- Fahrerapp zeigt sie als KW 36; hier nur die Reihenfolge fuer "letzte 3 freigegebene Wochen".
-- settlements bleiben unveraendert.
create or replace function public.fahrer_app_abrechnungen(p_fahrer_id integer default null)
 returns table(woche text, freigegeben_am timestamp with time zone, mietmodell text, bolt_brutto numeric, uber_fahrpreis numeric, mypos_summe numeric, bruttoumsatz_gesamt numeric, bolt_auszahlung numeric, uber_auszahlung numeric, wir_bekommen numeric, miete numeric, prozent_abzug numeric, abzug_gesamt numeric, korrektur numeric, korrektur_note text, lohn numeric, auszahlung numeric, du_bekommst numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  with ziel as (select public.fahrer_app_ziel(p_fahrer_id) as id),
  wochen as (
    select fr.woche, fr.freigegeben_am from public.abrechnung_freigaben fr
    order by case fr.woche when '2026-W37k' then '2026-W36' else fr.woche end desc limit 3
  )
  select s.woche, w.freigegeben_am, s.mietmodell,
         s.bolt_brutto, s.uber_fahrpreis, s.mypos_summe, s.bruttoumsatz_gesamt,
         s.bolt_auszahlung, s.uber_auszahlung, s.wir_bekommen,
         s.miete, s.prozent_abzug, s.abzug_gesamt,
         s.korrektur, s.korrektur_note, s.lohn, s.auszahlung,
         coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)
  from wochen w
  join public.settlements s on s.woche = w.woche
  cross join ziel
  where ziel.id is not null
    and s.status = 'berechnet'
    and s.fahrer_name not like '\_\_%'
    and public.settlement_fahrer(s.telefon, s.fahrer_name) = ziel.id
  order by case s.woche when '2026-W37k' then '2026-W36' else s.woche end desc, s.id
$function$;
