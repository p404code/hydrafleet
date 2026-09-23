-- ============================================================================
-- API-Abrechnung: dieselbe Rechnung wie der AbrechnungsBot (berechnung-v15.js),
-- aber Bolt und Uber aus der API. Nur Ansicht, nichts wird gespeichert.
-- Spec: docs/superpowers/specs/2026-09-23-api-abrechnung-design.md
--
-- * settlements, fahrer, AbrechnungsBot werden nur gelesen.
-- * Bolt/Uber-Definitionen woertlich wie in abrechnung_abgleich.
-- * myPOS, Lohn, Korrektur und die Pauschale der Woche kommen aus der alten
--   Abrechnung ("aus CSV"). Mehrere alte Zeilen je Fahrer -> Pauschale nur einmal.
-- * Formel gegengeprueft 23.09.: auf die alten Eingaben angewandt trifft sie
--   settlements.auszahlung in KW37, KW37k, KW38 bei 144/144 Zeilen.
-- * Ab 2026-W37 (davor Bolt-Wochenverschiebung, siehe datenpruefung Punkt 5).
-- * Fehlt eine Plattform in einer Woche: Felder null, befund 'unvollständig'.
-- ============================================================================

create or replace view public.api_abrechnung with (security_invoker = true) as
with bolt as (
  select o.woche, bd.fahrer_id,
         round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2) as brutto,
         round(sum(coalesce(o.net_earnings,0))
               - sum(case when o.payment_method = 'cash' then coalesce(o.ride_price,0) else 0 end), 2) as auszahlung
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null and o.woche >= '2026-W37'
  group by 1, 2
),
uber as (
  select r.woche, ud.fahrer_id,
         round(sum(coalesce(r.fahrpreis,0)), 2) as brutto,
         round(sum(coalesce(r.gezahlt,0)), 2) as auszahlung
  from public.uber_reports r
  join public.uber_drivers ud on ud.driver_uuid = r.driver_uuid
  where ud.fahrer_id is not null and r.umsaetze is not null and r.woche >= '2026-W37'
  group by 1, 2
),
bolt_wochen as (select distinct woche from public.bolt_orders where woche >= '2026-W37'),
uber_wochen as (select distinct woche from public.uber_reports where umsaetze is not null and woche >= '2026-W37'),
alt as (
  select s.woche, public.settlement_fahrer(s.telefon, s.fahrer_name) as fahrer_id,
         string_agg(distinct s.fahrer_name, ' / ') as fahrer_name,
         count(*)::integer as zeilen,
         max(s.mietmodell) as mietmodell,
         max(coalesce(s.miete,0)) as miete_einmal,
         sum(coalesce(s.miete,0)) as miete,
         sum(coalesce(s.bolt_brutto,0)) as bolt_brutto,
         sum(coalesce(s.uber_fahrpreis,0)) as uber_fahrpreis,
         sum(coalesce(s.mypos_summe,0)) as mypos_summe,
         sum(coalesce(s.prozent_abzug,0)) as prozent_abzug,
         sum(coalesce(s.lohn,0)) as lohn,
         sum(coalesce(s.korrektur,0)) as korrektur,
         string_agg(nullif(s.korrektur_note,''), '; ') as korrektur_note,
         sum(coalesce(s.auszahlung,0)) as auszahlung
  from public.settlements s
  where s.woche >= '2026-W37' and s.fahrer_name not like '\_\_%'
  group by 1, 2
),
schluessel as (
  select woche, fahrer_id from bolt
  union select woche, fahrer_id from uber
  union select woche, fahrer_id from alt where fahrer_id is not null
),
eingang as (
  select k.woche, k.fahrer_id,
         coalesce(f.name, a.fahrer_name) as fahrer,
         f.notion_fahrer_id,
         exists (select 1 from bolt_wochen w where w.woche = k.woche) as bolt_gesynct,
         exists (select 1 from uber_wochen w where w.woche = k.woche) as uber_gesynct,
         b.brutto as b_brutto, b.auszahlung as b_ausz,
         u.brutto as u_brutto, u.auszahlung as u_ausz,
         coalesce(a.mypos_summe, 0) as mypos_summe,
         coalesce(a.lohn, 0) as lohn,
         coalesce(a.korrektur, 0) as korrektur,
         a.korrektur_note,
         coalesce(a.mietmodell, f.mietmodell) as mietmodell,
         coalesce(a.miete_einmal, f.basis_miete, 0) as miete,
         coalesce(f.prozent_satz, 0) as prozent_satz,
         coalesce(nullif(f.prozent_schwelle, 0), 1200) as prozent_schwelle,
         a.zeilen as alt_zeilen, a.fahrer_name as alt_fahrer_name,
         a.bolt_brutto as alt_bolt_brutto, a.uber_fahrpreis as alt_uber_fahrpreis,
         a.miete as alt_miete, a.prozent_abzug as alt_prozent_abzug,
         a.auszahlung as alt_auszahlung, a.lohn as alt_lohn
  from schluessel k
  left join bolt b on b.woche = k.woche and b.fahrer_id = k.fahrer_id
  left join uber u on u.woche = k.woche and u.fahrer_id = k.fahrer_id
  left join alt a  on a.woche = k.woche and a.fahrer_id = k.fahrer_id
  left join public.fahrer f on f.id = k.fahrer_id
),
brutto as (
  select e.*,
         -- nicht gesynct -> null (fehlende Daten sind keine Abweichung), gesynct ohne Fahrten -> 0
         case when e.bolt_gesynct then coalesce(e.b_brutto, 0) end as bolt_brutto,
         case when e.bolt_gesynct then coalesce(e.b_ausz, 0) end as bolt_auszahlung,
         case when e.uber_gesynct then coalesce(e.u_brutto, 0) end as uber_fahrpreis,
         case when e.uber_gesynct then coalesce(e.u_ausz, 0) end as uber_auszahlung,
         coalesce(e.b_brutto,0) + coalesce(e.u_brutto,0) + e.mypos_summe as bruttoumsatz_gesamt,
         coalesce(e.b_ausz,0) + coalesce(e.u_ausz,0) + e.mypos_summe as wir_bekommen
  from eingang e
),
prozent as (
  select b.*,
         round(case b.mietmodell
           when 'f11' then greatest(b.bruttoumsatz_gesamt - 1100, 0) * 0.10
           when 'f12' then greatest(b.bruttoumsatz_gesamt - 1200, 0) * 0.10
           else case when b.prozent_satz > 0 and b.bruttoumsatz_gesamt > b.prozent_schwelle
                     then (b.bruttoumsatz_gesamt - b.prozent_schwelle) * b.prozent_satz / 100 else 0 end
         end, 2) as prozent_abzug
  from brutto b
),
gerechnet as (
  select p.*,
         p.miete + p.prozent_abzug as abzug_gesamt,
         round(p.wir_bekommen - p.miete - p.prozent_abzug + p.korrektur, 2) as auszahlung
  from prozent p
)
select g.woche, g.fahrer_id, g.fahrer, g.notion_fahrer_id,
       g.bolt_gesynct, g.uber_gesynct,
       g.bolt_brutto, g.bolt_auszahlung, g.uber_fahrpreis, g.uber_auszahlung,
       g.mypos_summe, g.bruttoumsatz_gesamt, g.wir_bekommen,
       g.mietmodell, g.miete, g.prozent_abzug, g.abzug_gesamt,
       g.korrektur, g.korrektur_note, g.lohn, g.auszahlung,
       round(g.auszahlung - g.lohn, 2) as du_bekommst,
       g.alt_zeilen, g.alt_fahrer_name, g.alt_bolt_brutto, g.alt_uber_fahrpreis,
       g.alt_miete, g.alt_prozent_abzug, g.alt_auszahlung,
       round(g.alt_auszahlung - g.alt_lohn, 2) as alt_du_bekommst,
       round((g.auszahlung - g.lohn) - (g.alt_auszahlung - g.alt_lohn), 2) as diff,
       case
         when not (g.bolt_gesynct and g.uber_gesynct) then 'unvollständig'
         when g.alt_zeilen is null then 'nur API'
         when g.b_brutto is null and g.u_brutto is null then 'nur alt'
         when abs((g.auszahlung - g.lohn) - (g.alt_auszahlung - g.alt_lohn)) < 0.01 then 'ok'
         when abs((g.auszahlung - g.lohn) - (g.alt_auszahlung - g.alt_lohn)) < 1.00 then 'rundung'
         else 'weicht ab'
       end as befund,
       null::text as konto
from gerechnet g
union all
-- Alte Zeilen ohne Fahrer-Zuordnung (z. B. WARNUNG_KEIN_FAHRER)
select a.woche, null, a.fahrer_name, null, null, null,
       null, null, null, null, a.mypos_summe, null, null,
       a.mietmodell, null, null, null, a.korrektur, a.korrektur_note, a.lohn, null,
       null, a.zeilen, a.fahrer_name, a.bolt_brutto, a.uber_fahrpreis,
       a.miete, a.prozent_abzug, a.auszahlung, round(a.auszahlung - a.lohn, 2), null,
       'alt ohne Fahrer', null
from alt a where a.fahrer_id is null
union all
-- API-Konten ohne Fahrer (fehlen sonst in beiden Summen)
select o.woche, null, trim(coalesce(bd.first_name,'') || ' ' || coalesce(bd.last_name,'')), null, true, null,
       round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2),
       round(sum(coalesce(o.net_earnings,0)) - sum(case when o.payment_method = 'cash' then coalesce(o.ride_price,0) else 0 end), 2),
       null, null, 0, null, null, null, null, null, null, 0, null, 0, null, null,
       null, null, null, null, null, null, null, null, null,
       'Konto ohne Fahrer', 'bolt ' || left(bd.driver_uuid, 8)
from public.bolt_orders o
join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
where bd.fahrer_id is null and o.woche >= '2026-W37'
group by o.woche, bd.driver_uuid, bd.first_name, bd.last_name
union all
select r.woche, null, trim(coalesce(ud.vorname,'') || ' ' || coalesce(ud.nachname,'')), null, null, true,
       null, null, round(sum(coalesce(r.fahrpreis,0)), 2), round(sum(coalesce(r.gezahlt,0)), 2),
       0, null, null, null, null, null, null, 0, null, 0, null, null,
       null, null, null, null, null, null, null, null, null,
       'Konto ohne Fahrer', 'uber ' || left(ud.driver_uuid, 8)
from public.uber_reports r
join public.uber_drivers ud on ud.driver_uuid = r.driver_uuid
where ud.fahrer_id is null and r.umsaetze is not null and r.woche >= '2026-W37'
group by r.woche, ud.driver_uuid, ud.vorname, ud.nachname;

revoke all on public.api_abrechnung from anon;
grant select on public.api_abrechnung to authenticated;


create or replace view public.api_abrechnung_wochen with (security_invoker = true) as
select woche,
       bool_or(bolt_gesynct) filter (where fahrer_id is not null) as bolt_gesynct,
       bool_or(uber_gesynct) filter (where fahrer_id is not null) as uber_gesynct,
       count(*) filter (where fahrer_id is not null)::integer as fahrer,
       round(sum(du_bekommst) filter (where fahrer_id is not null), 2) as summe_du_bekommst,
       round(sum(alt_du_bekommst) filter (where fahrer_id is not null), 2) as summe_alt,
       count(*) filter (where befund = 'weicht ab')::integer as anzahl_abweichend
from public.api_abrechnung
group by woche;

revoke all on public.api_abrechnung_wochen from anon;
grant select on public.api_abrechnung_wochen to authenticated;
