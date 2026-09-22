-- Ergaenzungen zum Bolt-Sync, am 2026-09-22 eingespielt.
-- Diese Anweisungen sind bereits angewendet und in supabase_migrations.schema_migrations
-- registriert (verbindungen_externe_id, bolt_drivers_fahrer_zuordnung, bolt_abgleich_view,
-- pg_cron_pg_net, bolt_sync_zeitplan, fahrer_notion_id, fahrer_uebersicht_view).
-- Hier stehen sie, damit das Repo den Stand der Datenbank abbildet. Alles ist
-- wiederholbar formuliert, ein erneuter Lauf richtet keinen Schaden an.

-- === 1. Anbieter-ID je Verbindung (Bolt: company_id) ===
alter table public.verbindungen add column if not exists externe_id text;
comment on column public.verbindungen.externe_id is
  'ID des Anbieters fuer diese Verbindung, z.B. Bolt company_id';

-- === 2. Zuordnung Bolt-Konto -> Fahrer ===
-- Ein Fahrer hat eine Bolt-ID JE COMPANY, nicht eine insgesamt. Die urspruengliche
-- Spalte fahrer.bolt_driver_uuid konnte das nicht abbilden und ist entfallen.
alter table public.bolt_drivers
  add column if not exists fahrer_id integer references public.fahrer(id),
  add column if not exists zuordnung_quelle text;   -- telefon | name | manuell
comment on column public.bolt_drivers.fahrer_id is
  'Zugeordneter Fahrer. Mehrere Bolt-Konten koennen auf denselben Fahrer zeigen.';
create index if not exists bolt_drivers_fahrer_idx on public.bolt_drivers (fahrer_id);
drop index if exists public.fahrer_bolt_driver_uuid_idx;
alter table public.fahrer drop column if exists bolt_driver_uuid;

-- === 3. Notion-Fahrernummer ===
alter table public.fahrer add column if not exists notion_fahrer_id integer;
comment on column public.fahrer.notion_fahrer_id is
  'Auto-increment-ID aus der Notion-Fahrer-DB. Die Nummer, die im Dashboard angezeigt wird.';
create index if not exists fahrer_notion_id_idx on public.fahrer (notion_fahrer_id);

-- === 4. Zeitplan ===
-- pg_cron ruft die Edge Function bolt-sync auf. Der service_role-Key steht NICHT in
-- der Job-Definition, sondern wird zur Laufzeit aus dem Vault gelesen
-- (vault.secrets, Name 'service_role_key' - einmalig per RPC gesetzt, nicht hier).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'bolt-sync-woechentlich') then
    perform cron.unschedule('bolt-sync-woechentlich');
  end if;
  perform cron.schedule(
    'bolt-sync-woechentlich',
    '0 4 * * 1',
    $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/bolt-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
    $job$
  );
end $do$;

-- === 5. Vergleich API gegen CSV, fuer den Parallelbetrieb ===
create or replace view public.bolt_abgleich with (security_invoker = true) as
with api as (
  select o.woche, bd.fahrer_id,
         count(*)::int as auftraege,
         round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2) as api_brutto,
         round(sum(coalesce(o.net_earnings,0))
             - sum(case when o.payment_method = 'cash' then coalesce(o.ride_price,0) else 0 end), 2)
           as api_auszahlung
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null
  group by 1, 2
),
csv as (
  select s.woche, f.id as fahrer_id, s.fahrer_name, s.bolt_brutto, s.bolt_auszahlung
  from public.settlements s
  join public.fahrer f on f.name = s.fahrer_name
  where s.fahrer_name not like '\_\_%'
)
select
  coalesce(a.woche, c.woche)         as woche,
  coalesce(c.fahrer_name, f.name)    as fahrer,
  coalesce(a.fahrer_id, c.fahrer_id) as fahrer_id,
  a.auftraege,
  a.api_brutto, c.bolt_brutto as csv_brutto,
  round(coalesce(a.api_brutto, 0) - coalesce(c.bolt_brutto, 0), 2)         as diff_brutto,
  a.api_auszahlung, c.bolt_auszahlung as csv_auszahlung,
  round(coalesce(a.api_auszahlung, 0) - coalesce(c.bolt_auszahlung, 0), 2) as diff_auszahlung,
  case when a.fahrer_id is null then 'nur CSV'
       when c.fahrer_id is null then 'nur API'
       else 'beide' end             as quelle
from api a
full join csv c on c.woche = a.woche and c.fahrer_id = a.fahrer_id
left join public.fahrer f on f.id = a.fahrer_id;

grant select on public.bolt_abgleich to authenticated;

-- === 6. Datenquelle fuer den Fahrer-Tab ===
-- Saldo   = offener Betrag wie im Tab "Muessen zahlen".
-- Zahlung = Auszahlung der zuletzt abgerechneten Woche.
create or replace view public.fahrer_uebersicht with (security_invoker = true) as
with kfz as (
  select regexp_replace(upper(coalesce(reg_number,'')), '[^A-Z0-9]', '', 'g') as kz,
         min(model) as modell, min(year) as baujahr, min(color) as farbe,
         min(state) as fahrzeug_status
  from public.bolt_vehicles
  where reg_number is not null and reg_number <> ''
  group by 1
),
letzte as (
  select distinct on (fahrer_name) fahrer_name, woche, auszahlung
  from public.settlements where fahrer_name not like '\_\_%'
  order by fahrer_name, woche desc
),
schuld as (
  select s.fahrer_name,
         round(sum(greatest(abs(s.auszahlung) - coalesce(k.bezahlt, 0), 0)), 2) as offen
  from public.settlements s
  left join (select fahrer_name, woche, sum(betrag) as bezahlt
               from public.kassier_zahlungen group by 1, 2) k
         on k.fahrer_name = s.fahrer_name and k.woche = s.woche
  where s.auszahlung < 0 and s.fahrer_name not like '\_\_%'
  group by 1
),
bolt as (
  select fahrer_id, count(*)::int as konten,
         count(*) filter (where state = 'active')::int as konten_aktiv,
         max(driver_rating) as bewertung
  from public.bolt_drivers where fahrer_id is not null group by 1
),
fahrten as (
  select bd.fahrer_id, count(*)::int as fahrten_30t
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null and o.order_status = 'finished'
    and o.order_finished_at > now() - interval '30 days'
  group by 1
),
doppelt as (
  select notion_fahrer_id from public.fahrer
  where notion_fahrer_id is not null group by 1 having count(*) > 1
)
select
  f.id as fahrer_id, f.notion_fahrer_id, f.name, f.telefon, f.kennzeichen, f.aktiv, f.mietmodell,
  split_part(kfz.modell, ' ', 1) as marke,
  nullif(trim(substr(kfz.modell, length(split_part(kfz.modell,' ',1)) + 1)), '') as modell,
  kfz.baujahr, kfz.farbe, kfz.fahrzeug_status,
  coalesce(b.konten, 0) as bolt_konten, coalesce(b.konten_aktiv, 0) as bolt_konten_aktiv,
  b.bewertung as bolt_bewertung,
  coalesce(fa.fahrten_30t, 0) as fahrten_30t,
  l.woche as letzte_woche, l.auszahlung as letzte_auszahlung,
  coalesce(sch.offen, 0) as offen,
  array_remove(array[
    case when coalesce(f.telefon,'') = ''     then 'keine Telefonnummer' end,
    case when coalesce(f.kennzeichen,'') = '' then 'kein Kennzeichen' end,
    case when f.notion_fahrer_id is null      then 'keine Notion-ID' end,
    case when coalesce(b.konten, 0) = 0       then 'kein Bolt-Konto' end,
    case when d.notion_fahrer_id is not null  then 'Notion-ID doppelt vergeben' end,
    case when coalesce(f.kennzeichen,'') <> '' and kfz.kz is null
                                              then 'Kennzeichen nicht bei Bolt' end
  ], null) as probleme
from public.fahrer f
left join kfz on kfz.kz = regexp_replace(upper(coalesce(f.kennzeichen,'')), '[^A-Z0-9]', '', 'g')
              and coalesce(f.kennzeichen,'') <> ''
left join letzte l   on l.fahrer_name = f.name
left join schuld sch on sch.fahrer_name = f.name
left join bolt b     on b.fahrer_id = f.id
left join fahrten fa on fa.fahrer_id = f.id
left join doppelt d  on d.notion_fahrer_id = f.notion_fahrer_id;

grant select on public.fahrer_uebersicht to authenticated;
