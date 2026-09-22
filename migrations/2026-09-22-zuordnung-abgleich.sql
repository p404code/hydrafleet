-- Wer faehrt welches Auto - drei Quellen nebeneinander.
-- Am 2026-09-22 eingespielt (zuordnung_abgleich_view).
--
--   Notion       fahrer.kennzeichen        (davon haengt die Miete in settlements ab)
--   Bolt-Konto   bolt_drivers.active_vehicle_reg
--   Wirklichkeit bolt_orders.vehicle_license_plate, letzte 30 Tage
--
-- Wo Notion und Wirklichkeit auseinandergehen, wird die falsche Pauschale verrechnet.
create or replace view public.zuordnung_abgleich with (security_invoker = true) as
with gefahren as (
  select bd.fahrer_id,
         public.kennzeichen_key(o.vehicle_license_plate) as kz,
         min(o.vehicle_license_plate) as reg,
         count(*)::int as fahrten
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null
    and o.order_status = 'finished'
    and o.order_finished_at > now() - interval '30 days'
    and coalesce(o.vehicle_license_plate, '') <> ''
  group by 1, 2
),
haupt as (
  select distinct on (fahrer_id) fahrer_id, kz, reg, fahrten
  from gefahren order by fahrer_id, fahrten desc
),
summe as (
  select fahrer_id, count(*)::int as autos, sum(fahrten)::int as fahrten_ges
  from gefahren group by 1
),
bolt_zuw as (
  select fahrer_id, public.kennzeichen_key(min(active_vehicle_reg)) as kz,
         min(active_vehicle_reg) as reg
  from public.bolt_drivers
  where fahrer_id is not null and coalesce(active_vehicle_reg, '') <> ''
  group by 1
)
select
  f.id as fahrer_id, f.name as fahrer,
  f.kennzeichen        as auto_laut_notion,
  fp_n.pauschale       as pauschale_laut_notion,
  fp_n.pauschal_modell as modell_laut_notion,
  bz.reg               as auto_laut_bolt_konto,
  h.reg                as auto_tatsaechlich,
  h.fahrten            as fahrten_hauptauto,
  s.autos              as verschiedene_autos,
  s.fahrten_ges        as fahrten_gesamt,
  fp_t.pauschale       as pauschale_tatsaechlich,
  fp_t.pauschal_modell as modell_tatsaechlich,
  round(coalesce(fp_t.pauschale, 0) - coalesce(fp_n.pauschale, 0), 2) as pauschale_differenz,
  case
    when h.kz is null                                  then 'keine Fahrten'
    when coalesce(f.kennzeichen, '') = ''              then 'in Notion kein Auto hinterlegt'
    when public.kennzeichen_key(f.kennzeichen) = h.kz  then 'stimmt'
    else 'Notion weicht ab'
  end as befund
from public.fahrer f
left join haupt    h   on h.fahrer_id  = f.id
left join summe    s   on s.fahrer_id  = f.id
left join bolt_zuw bz  on bz.fahrer_id = f.id
left join public.fuhrpark fp_n on fp_n.kennzeichen_key = public.kennzeichen_key(f.kennzeichen)
left join public.fuhrpark fp_t on fp_t.kennzeichen_key = h.kz
where f.aktiv;

grant select on public.zuordnung_abgleich to authenticated;
