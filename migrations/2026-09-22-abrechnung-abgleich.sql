-- abrechnung_abgleich - was die Plattformen sagen, neben dem was abgerechnet wurde.
--
-- Rein lesend. settlements wird nicht angefasst, der AbrechnungsBot bleibt die
-- Instanz, die ueber Geld entscheidet. Diese View zeigt nur, wo API und
-- Abrechnung auseinandergehen.
--
-- Geprueft am 2026-09-22 gegen KW 2026-W38 (48 Fahrer):
--   42 ok, 5 weichen ab, 1 Fahrer doppelt in public.fahrer,
--   3 Plattformkonten ohne Fahrer-Zuordnung.
-- Spaltenzuordnung, empirisch bestimmt:
--   bolt_orders.ride_price + cancellation_fee  -> settlements.bolt_brutto
--   uber_reports.fahrpreis                     -> settlements.uber_fahrpreis
--   uber_reports.gezahlt                       -> settlements.uber_auszahlung

-- Fahrer zu einer Abrechnungszeile finden: zuerst ueber die Telefonnummer
-- (trifft 48/48 in KW38), erst dann ueber den Namen. Der Name ist der
-- unzuverlaessigere Schluessel - genau deshalb gibt es dieses Projekt.
create or replace function public.settlement_fahrer(p_telefon text, p_name text)
returns integer
language sql stable
set search_path = public
as $$
  select f.id from public.fahrer f
  where (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon))
     or f.name = p_name
  order by (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) desc,
           f.id
  limit 1
$$;

comment on function public.settlement_fahrer(text, text) is
  'Ordnet eine settlements-Zeile einem fahrer zu: Telefonnummer vor Name.';

create or replace view public.abrechnung_abgleich
with (security_invoker = true) as
with bolt as (
  select o.woche,
         bd.fahrer_id,
         count(*)::int as bolt_auftraege,
         round(sum(coalesce(o.ride_price, 0) + coalesce(o.cancellation_fee, 0)), 2) as api_brutto,
         round(sum(coalesce(o.net_earnings, 0))
             - sum(case when o.payment_method = 'cash' then coalesce(o.ride_price, 0) else 0 end), 2) as api_auszahlung
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null
  group by o.woche, bd.fahrer_id
),
uber as (
  -- umsaetze IS NULL kennzeichnet die Sammelzeile der Organisation (in KW38
  -- -35.556,55 EUR). Das ist kein Fahrer und darf nie mitsummiert werden.
  select r.woche,
         ud.fahrer_id,
         round(sum(coalesce(r.fahrpreis, 0))::numeric, 2) as api_brutto,
         round(sum(coalesce(r.gezahlt, 0))::numeric, 2)   as api_auszahlung
  from public.uber_reports r
  join public.uber_drivers ud on ud.driver_uuid = r.driver_uuid
  where ud.fahrer_id is not null and r.umsaetze is not null
  group by r.woche, ud.fahrer_id
),
bolt_wochen as (select distinct woche from bolt),
uber_wochen as (select distinct woche from uber),
abr as (
  select s.woche,
         public.settlement_fahrer(s.telefon, s.fahrer_name) as fahrer_id,
         s.fahrer_name,
         sum(s.bolt_brutto)     as bolt_brutto,
         sum(s.bolt_auszahlung) as bolt_auszahlung,
         sum(s.uber_fahrpreis)  as uber_brutto,
         sum(s.uber_auszahlung) as uber_auszahlung
  from public.settlements s
  where s.fahrer_name not like '\_\_%'
  group by 1, 2, 3
),
-- Plattformkonten ohne Fahrer-Zuordnung: einzeln, nicht zu einer Sammelzeile
-- verschmolzen, sonst verschwindet das Geld aus der Wochensumme.
lose as (
  select r.woche, null::int as fahrer_id,
         trim(coalesce(ud.vorname,'') || ' ' || coalesce(ud.nachname,'')) as fahrer,
         'uber'::text as plattform, r.driver_uuid as konto,
         round(coalesce(r.fahrpreis,0)::numeric, 2) as api_brutto,
         round(coalesce(r.gezahlt,0)::numeric, 2)   as api_auszahlung
  from public.uber_reports r
  join public.uber_drivers ud on ud.driver_uuid = r.driver_uuid
  where ud.fahrer_id is null and r.umsaetze is not null
  union all
  select o.woche, null::int,
         trim(coalesce(bd.first_name,'') || ' ' || coalesce(bd.last_name,'')),
         'bolt', bd.driver_uuid,
         round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2),
         round(sum(coalesce(o.net_earnings,0))
             - sum(case when o.payment_method='cash' then coalesce(o.ride_price,0) else 0 end), 2)
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is null
  group by o.woche, bd.driver_uuid, bd.first_name, bd.last_name
),
-- Schluesselliste zuerst, dann drei LEFT JOINs. Eine FULL-JOIN-Kette mit
-- coalesce() in der ON-Bedingung waere hier still falsch geworden.
schluessel as (
  select woche, fahrer_id from bolt
  union
  select woche, fahrer_id from uber
  union
  select woche, fahrer_id from abr where fahrer_id is not null
),
zusammen as (
  select k.woche, k.fahrer_id,
         coalesce(a.fahrer_name, f.name) as fahrer,
         null::text as plattform_konto,
         b.bolt_auftraege,
         b.api_brutto as bolt_api_brutto, a.bolt_brutto as bolt_abgerechnet,
         b.api_auszahlung as bolt_api_auszahlung, a.bolt_auszahlung as bolt_abg_auszahlung,
         u.api_brutto as uber_api_brutto, a.uber_brutto as uber_abgerechnet,
         u.api_auszahlung as uber_api_auszahlung, a.uber_auszahlung as uber_abg_auszahlung,
         (a.woche is not null) as hat_abrechnung,
         exists (select 1 from bolt_wochen w where w.woche = k.woche) as bolt_gesynct,
         exists (select 1 from uber_wochen w where w.woche = k.woche) as uber_gesynct
  from schluessel k
  left join bolt b on b.woche = k.woche and b.fahrer_id = k.fahrer_id
  left join uber u on u.woche = k.woche and u.fahrer_id = k.fahrer_id
  left join abr  a on a.woche = k.woche and a.fahrer_id = k.fahrer_id
  left join public.fahrer f on f.id = k.fahrer_id
),
-- Eine Plattform wird nur verglichen, wenn sie fuer diese Woche ueberhaupt
-- gesynct wurde. Sonst liest sich eine fehlende Woche wie eine Abweichung -
-- genau das ist beim ersten Entwurf passiert (KW37 ohne Uber-Daten: 31
-- angebliche Abweichungen, in Wahrheit null).
gerechnet as (
  select *,
         case when bolt_gesynct then round(coalesce(bolt_api_brutto,0) - coalesce(bolt_abgerechnet,0), 2) end as bolt_diff,
         case when uber_gesynct then round(coalesce(uber_api_brutto,0) - coalesce(uber_abgerechnet,0), 2) end as uber_diff
  from zusammen
)
select woche, fahrer_id, fahrer, plattform_konto, bolt_auftraege,
       bolt_api_brutto, bolt_abgerechnet, bolt_diff,
       bolt_api_auszahlung, bolt_abg_auszahlung,
       uber_api_brutto, uber_abgerechnet, uber_diff,
       uber_api_auszahlung, uber_abg_auszahlung,
       round(abs(coalesce(bolt_diff,0)) + abs(coalesce(uber_diff,0)), 2) as diff_gesamt,
       case
         when not bolt_gesynct and not uber_gesynct then 'keine API-Daten'
         when not hat_abrechnung then 'nur Plattform'
         when bolt_api_brutto is null and uber_api_brutto is null then 'nur Abrechnung'
         when abs(coalesce(bolt_diff,0)) + abs(coalesce(uber_diff,0)) < 0.01 then 'ok'
         when abs(coalesce(bolt_diff,0)) + abs(coalesce(uber_diff,0)) < 1.00 then 'Rundung'
         else 'weicht ab'
       end as befund
from gerechnet
union all
select woche, fahrer_id, fahrer, plattform || ' ' || left(konto, 8), null,
       case when plattform='bolt' then api_brutto end, null, round(case when plattform='bolt' then api_brutto else 0 end, 2),
       case when plattform='bolt' then api_auszahlung end, null,
       case when plattform='uber' then api_brutto end, null, round(case when plattform='uber' then api_brutto else 0 end, 2),
       case when plattform='uber' then api_auszahlung end, null,
       round(api_brutto, 2),
       'Konto ohne Fahrer'
from lose;

comment on view public.abrechnung_abgleich is
  'Bolt- und Uber-Zahlen aus der API neben settlements, je Woche und Fahrer. Nur lesend. Eine Plattform wird nur verglichen, wenn sie fuer die Woche gesynct ist.';

grant select on public.abrechnung_abgleich to authenticated;
