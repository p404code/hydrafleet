-- Fuhrpark aus drei Quellen: Notion, Bolt, Uber.
-- Am 2026-09-22 eingespielt (uber_fahrzeuge_und_fahrten,
-- fuhrpark_uebersicht_kombiniert_v2, _v3). Diese Datei enthaelt den Endstand.
--
-- Zweck: sehen, wo Notion noch stimmt und wo nicht - als Vorstufe zur Abloesung.
-- Der Fahrzeugbestand ist die VEREINIGUNG aller drei Quellen, nicht mehr nur die
-- Notion-Liste. Fahrzeuge, die nur Bolt oder nur Uber kennt, fallen dadurch auf.
-- Beim Fahrer ebenso: drei Spalten nebeneinander statt einer Behauptung.
--
-- Zwei Fallstricke, die beim Bauen aufgetreten sind und hier geloest bleiben:
--   * fahrer_notion darf NICHT min(id) und min(name) unabhaengig ziehen. Wo sich
--     zwei Fahrer ein Kennzeichen teilen (W-7298TX: Elbanhawy mohamed und Batyr
--     Yevloev), kaeme sonst die ID des einen mit dem Namen des anderen heraus.
--   * Eine Plattform mit sehr wenigen Fahrten darf eine mit vielen nicht
--     ueberstimmen (W 1061 TX: 4 Bolt-Fahrten gegen 96 Uber-Fahrten). Fuer den
--     Befund zaehlt eine Plattform erst ab 5 Fahrten.

drop view if exists public.fuhrpark_uebersicht;

create view public.fuhrpark_uebersicht with (security_invoker = true) as
with kz_notion as (select kennzeichen_key kz from public.fuhrpark),
kz_bolt as (
  select public.kennzeichen_key(reg_number) kz from public.bolt_vehicles
  where coalesce(reg_number, '') <> '' group by 1
),
kz_uber as (
  select kennzeichen_key kz from public.uber_vehicles
  where coalesce(kennzeichen_key, '') <> '' group by 1
),
alle as (select kz from kz_notion union select kz from kz_bolt union select kz from kz_uber),
bolt as (
  select public.kennzeichen_key(reg_number) kz,
         count(*) filter (where state = 'active')::int aktiv,
         min(model) modell, min(year) baujahr, min(color) farbe, min(seats) sitze
  from public.bolt_vehicles where coalesce(reg_number, '') <> '' group by 1
),
uber as (
  select distinct on (kennzeichen_key) kennzeichen_key kz,
         name modell, gesamtumsaetze, fahrten_gesamt, stunden_online
  from public.uber_vehicles where coalesce(kennzeichen_key, '') <> ''
  order by kennzeichen_key, zeitraum_bis desc
),
fn_roh as (
  select public.kennzeichen_key(kennzeichen) kz, id, name,
         count(*) over (partition by public.kennzeichen_key(kennzeichen)) anzahl
  from public.fahrer where aktiv and coalesce(kennzeichen, '') <> ''
),
fahrer_notion as (select distinct on (kz) kz, id fahrer_id, name, anzahl from fn_roh order by kz, id),
bolt_fahrten as (
  select public.kennzeichen_key(o.vehicle_license_plate) kz, bd.fahrer_id,
         coalesce(f.name, o.driver_name) name, count(*)::int n
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  left join public.fahrer f on f.id = bd.fahrer_id
  where o.order_status = 'finished' and o.order_finished_at > now() - interval '30 days'
    and coalesce(o.vehicle_license_plate, '') <> ''
  group by 1, 2, 3
),
fahrer_bolt as (select distinct on (kz) kz, fahrer_id, name, n from bolt_fahrten order by kz, n desc),
uber_fahrten as (
  select t.kennzeichen_key kz, ud.fahrer_id,
         coalesce(f.name, trim(coalesce(t.vorname,'') || ' ' || coalesce(t.nachname,''))) name,
         count(*)::int n
  from public.uber_trips t
  left join public.uber_drivers ud on ud.driver_uuid = t.driver_uuid
  left join public.fahrer f on f.id = ud.fahrer_id
  where t.status = 'completed' and coalesce(t.kennzeichen_key, '') <> ''
    and t.bestellt_am > (now() at time zone 'Europe/Vienna') - interval '30 days'
  group by 1, 2, 3
),
fahrer_uber as (select distinct on (kz) kz, fahrer_id, name, n from uber_fahrten order by kz, n desc),
umsatz_bolt as (
  select public.kennzeichen_key(vehicle_license_plate) kz, count(*)::int fahrten,
         round(sum(coalesce(ride_price, 0) + coalesce(cancellation_fee, 0)), 2) umsatz
  from public.bolt_orders
  where order_status = 'finished' and order_finished_at > now() - interval '30 days'
    and coalesce(vehicle_license_plate, '') <> ''
  group by 1
),
umsatz_uber as (
  select kennzeichen_key kz, count(*)::int fahrten
  from public.uber_trips
  where status = 'completed' and coalesce(kennzeichen_key, '') <> ''
    and bestellt_am > (now() at time zone 'Europe/Vienna') - interval '30 days'
  group by 1
),
basis as (
  select a.kz, n.*, b.aktiv b_aktiv, b.modell b_modell, b.baujahr, b.farbe, b.sitze, b.kz b_kz,
         u.kz u_kz, u.modell u_modell, u.gesamtumsaetze, u.stunden_online,
         fn.fahrer_id fn_id, fn.name fn_name, fn.anzahl fn_anzahl,
         fb.fahrer_id fb_id, fb.name fb_name, fb.n fb_n,
         fu.fahrer_id fu_id, fu.name fu_name, fu.n fu_n,
         ub.fahrten ub_f, ub.umsatz ub_u, uu.fahrten uu_f,
         case when coalesce(fb.n, 0) >= 5 then fb.fahrer_id end fb_id_stark,
         case when coalesce(fu.n, 0) >= 5 then fu.fahrer_id end fu_id_stark
  from alle a
  left join public.fuhrpark n on n.kennzeichen_key = a.kz
  left join bolt b            on b.kz  = a.kz
  left join uber u            on u.kz  = a.kz
  left join fahrer_notion fn  on fn.kz = a.kz
  left join fahrer_bolt   fb  on fb.kz = a.kz
  left join fahrer_uber   fu  on fu.kz = a.kz
  left join umsatz_bolt   ub  on ub.kz = a.kz
  left join umsatz_uber   uu  on uu.kz = a.kz
)
select
  kz                                     as kennzeichen_key,
  coalesce(kennzeichen, u_kz, b_kz)      as kennzeichen,
  coalesce(modell, u_modell, b_modell)   as modell,
  firma,
  coalesce(firma <> 'Abgemeldet', false) as angemeldet,
  array_remove(array[
    case when kennzeichen_key is not null then 'Notion' end,
    case when b_kz is not null            then 'Bolt'   end,
    case when u_kz is not null            then 'Uber'   end
  ], null)                               as quellen,
  fn_name as fahrer_notion, fb_name as fahrer_bolt, fu_name as fahrer_uber,
  fb_n as bolt_fahrten_hauptfahrer, fu_n as uber_fahrten_hauptfahrer,
  coalesce(fn_id, fb_id, fu_id)          as fahrer_id,
  case
    when fb_id_stark is null and fu_id_stark is null            then 'keine Fahrten'
    when fn_id is null                                          then 'nur Plattform'
    when coalesce(fb_id_stark, fn_id) = fn_id
     and coalesce(fu_id_stark, fn_id) = fn_id                   then 'einig'
    else 'weicht ab'
  end                                    as fahrer_befund,
  pauschale, pauschal_modell, eigentuemer,
  vin, kilometerstand, ablauf_pickerl, polizze,
  versicherung_monatlich, taxameter, bolt_werbung, dashcam,
  baujahr, farbe, sitze, coalesce(b_aktiv, 0) as bolt_aktiv,
  gesamtumsaetze as uber_umsatz_woche, stunden_online as uber_stunden_woche,
  coalesce(ub_f, 0) + coalesce(uu_f, 0)  as fahrten_30t,
  coalesce(ub_f, 0) as bolt_fahrten_30t, coalesce(uu_f, 0) as uber_fahrten_30t,
  coalesce(ub_u, 0) as bolt_umsatz_30t,
  array_remove(array[
    case when kennzeichen_key is null                           then 'nicht in Notion' end,
    case when kennzeichen_key is not null and firma <> 'Abgemeldet'
          and b_kz is null and u_kz is null                     then 'auf keiner Plattform' end,
    case when fn_id is null and (fb_id_stark is not null or fu_id_stark is not null)
                                                                then 'Fahrer nur laut Plattform' end,
    case when fn_id is not null and fb_id_stark is not null
          and fb_id_stark <> fn_id                              then 'Bolt widerspricht Notion' end,
    case when fn_id is not null and fu_id_stark is not null
          and fu_id_stark <> fn_id                              then 'Uber widerspricht Notion' end,
    case when pauschale is null and firma is not null
          and firma <> 'Abgemeldet'                             then 'keine Pauschale' end,
    case when fn_anzahl > 1                                     then 'mehrere Fahrer auf dem Kennzeichen' end
  ], null)                               as probleme
from basis;

grant select on public.fuhrpark_uebersicht to authenticated;
