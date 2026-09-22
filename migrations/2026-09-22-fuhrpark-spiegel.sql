-- Fuhrpark: Spiegel der Notion-DB in Supabase, plus Uebersicht fuer den Dashboard-Tab.
-- Am 2026-09-22 eingespielt und in supabase_migrations registriert
-- (fuhrpark_spiegel, fuhrpark_uebersicht_view, fuhrpark_uebersicht_pickerl).
--
-- Notion bleibt Quelle und Logik. Diese Tabelle ist eine Kopie zum Anzeigen und
-- Verknuepfen; geschrieben wird nur vom Import, nie aus dem Dashboard.
-- Die 73 Datenzeilen kamen per Einmal-Import aus der Notion-Fuhrpark-DB
-- (collection://5e514b18-c775-4bfd-8a31-4cfc227d6b2e) und stehen nicht in dieser Datei.

-- Kennzeichen zusammenfuehren: Notion "W 973BTX", Bolt "W-973BTX",
-- und Eintraege mit Zusatz wie "W-4262TX (neue)".
create or replace function public.kennzeichen_key(t text)
returns text language sql immutable as $$
  select regexp_replace(upper(split_part(coalesce(t, ''), '(', 1)), '[^A-Z0-9]', '', 'g');
$$;

create table if not exists public.fuhrpark (
  kennzeichen_key        text primary key,
  kennzeichen            text not null,
  modell                 text,
  firma                  text,          -- Notion "FA.": HYD, EH, Sorhan, E&E, PRIV, SON, SOR/SW, Abgemeldet
  pauschale              numeric,
  pauschal_modell        text,          -- fix | f11 | f12
  eigentuemer            text[],        -- Unsere | Kredit | Fremd | Spanish
  vin                    text,
  kilometerstand         text,          -- in Notion Freitext
  ablauf_pickerl         date,
  polizze                text,
  versicherung_monatlich text,
  taxameter              text[],
  bolt_werbung           boolean,
  dashcam                boolean,
  aktualisiert_am        timestamptz not null default now()
);

create index if not exists fuhrpark_firma_idx on public.fuhrpark (firma);

alter table public.fuhrpark enable row level security;
drop policy if exists app_users_read on public.fuhrpark;
create policy app_users_read on public.fuhrpark
  for select to authenticated using (is_app_user());

-- Eine Zeile je Fahrzeug fuer den Fuhrpark-Tab.
-- Notion liefert die kaufmaennischen Daten, Bolt die technischen,
-- fahrer/bolt_orders die Zuordnung und den Umsatz.
--
-- Hinweis: 'Pickerl abgelaufen' steht bewusst NICHT in der Problemliste. Nur 26 von 73
-- Fahrzeugen haben ueberhaupt ein Datum und alle liegen in der Vergangenheit - das Feld
-- wird in Notion nicht gepflegt. Die Spalte bleibt sichtbar, im Dashboard rot dargestellt.
create or replace view public.fuhrpark_uebersicht with (security_invoker = true) as
with bolt as (
  select public.kennzeichen_key(reg_number) as kz,
         count(*) filter (where state = 'active')::int as bolt_aktiv,
         min(model) as bolt_modell, min(year) as baujahr,
         min(color) as farbe, min(seats) as sitze
  from public.bolt_vehicles
  where coalesce(reg_number, '') <> ''
  group by 1
),
fhr as (
  select public.kennzeichen_key(kennzeichen) as kz,
         min(id) as fahrer_id, min(name) as fahrer_name, count(*)::int as fahrer_anzahl
  from public.fahrer
  where aktiv and coalesce(kennzeichen, '') <> ''
  group by 1
),
umsatz as (
  select public.kennzeichen_key(vehicle_license_plate) as kz,
         count(*)::int as fahrten_30t,
         round(sum(coalesce(ride_price, 0) + coalesce(cancellation_fee, 0)), 2) as umsatz_30t
  from public.bolt_orders
  where order_status = 'finished'
    and order_finished_at > now() - interval '30 days'
    and coalesce(vehicle_license_plate, '') <> ''
  group by 1
)
select
  f.kennzeichen_key, f.kennzeichen, f.modell, f.firma,
  f.pauschale, f.pauschal_modell, f.eigentuemer,
  f.vin, f.kilometerstand, f.ablauf_pickerl, f.polizze,
  f.versicherung_monatlich, f.taxameter, f.bolt_werbung, f.dashcam,
  (f.firma <> 'Abgemeldet')  as angemeldet,
  b.bolt_modell, b.baujahr, b.farbe, b.sitze,
  coalesce(b.bolt_aktiv, 0)  as bolt_aktiv,
  fh.fahrer_id, fh.fahrer_name,
  coalesce(u.fahrten_30t, 0) as fahrten_30t,
  coalesce(u.umsatz_30t, 0)  as umsatz_30t,
  array_remove(array[
    case when fh.fahrer_id is null and f.firma <> 'Abgemeldet' then 'kein Fahrer zugeordnet' end,
    case when b.kz is null and f.firma <> 'Abgemeldet'         then 'nicht bei Bolt' end,
    case when f.pauschale is null and f.firma <> 'Abgemeldet'  then 'keine Pauschale' end,
    case when fh.fahrer_anzahl > 1                             then 'mehrere Fahrer auf dem Kennzeichen' end
  ], null) as probleme
from public.fuhrpark f
left join bolt   b  on b.kz  = f.kennzeichen_key
left join fhr    fh on fh.kz = f.kennzeichen_key
left join umsatz u  on u.kz  = f.kennzeichen_key;

grant select on public.fuhrpark_uebersicht to authenticated;
