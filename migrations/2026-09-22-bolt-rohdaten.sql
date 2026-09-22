-- Bolt-Rohdaten. Vier Tabellen, eine je Endpunkt der Fleet Integration API.
-- Basis: https://node.bolt.eu/fleet-integration-gateway
--
-- Grundsatz: diese Tabellen werden NUR vom Sync befuellt und NIE von der Abrechnung
-- beschrieben. settlements bleibt das Ergebnis EINER Berechnung ueber alle Quellen,
-- sonst stehen die abgeleiteten Felder (bruttoumsatz_gesamt, auszahlung, ...) daneben falsch.
--
-- Jede Tabelle hat die ID des Anbieters als Schluessel => doppelter Import unmoeglich.
-- Jede Tabelle hat 'roh' mit der vollstaendigen Original-Antwort, damit ein spaeter
-- gebrauchtes Feld keinen Neuabruf der Historie erzwingt.


-- ============================================================
-- 1. bolt_orders  <- POST /fleetIntegration/v1/getFleetOrders
--    Eine Zeile je Auftrag. Enthaelt bewusst auch die Betriebsdaten
--    (Storno, No-Show, Distanzen, Zeitstempel), nicht nur die Geldfelder.
-- ============================================================
create table if not exists public.bolt_orders (
  order_reference          text primary key,   -- Bolts Auftrags-ID
  company_id               bigint not null,
  company_name             text,

  -- Fahrer: driver_uuid ersetzt das Namens-Matching, Name/Telefon nur zur Kontrolle
  driver_uuid              text,
  partner_uuid             text,
  driver_name              text,
  driver_phone             text,

  vehicle_license_plate    text,
  vehicle_model            text,

  order_status             text,               -- finished, client_cancelled, driver_rejected, ...
  driver_cancelled_reason  text,
  price_review_reason      text,
  payment_method           text,
  is_scheduled             boolean,
  is_optional              boolean,

  -- Kategorie der Fahrt (Bolt, XL, ...)
  category_name            text,
  category_seats           integer,
  category_vehicle_type    text,

  -- Der komplette Ablauf einer Fahrt. Daraus fallen Annahmequote, Wartezeit bis
  -- Pickup, Fahrtdauer und No-Show-Quote ohne Zusatzabruf heraus.
  order_created_at         timestamptz,
  order_accepted_at        timestamptz,
  order_pickup_at          timestamptz,
  order_drop_off_at        timestamptz,
  order_finished_at        timestamptz,
  order_cancelled_at       timestamptz,
  order_no_show_at         timestamptz,
  payment_confirmed_at     timestamptz,

  pickup_address           text,
  destination_address      text,
  ride_distance            numeric,
  predicted_ride_distance  numeric,
  road_distance_at_matching numeric,

  -- order_price, 1:1 aus der API. Welche Felder bolt_brutto/bolt_auszahlung ergeben,
  -- entscheidet der Abgleich mit dem CSV-Import derselben Woche - hier wird nichts geraten.
  ride_price               numeric,
  booking_fee              numeric,
  toll_fee                 numeric,
  cancellation_fee         numeric,
  tip                      numeric,
  net_earnings             numeric,
  cash_discount            numeric,
  in_app_discount          numeric,
  commission               numeric,

  -- Bewusst KEINE generated column: welcher Zeitstempel die Abrechnungswoche bestimmt,
  -- ist offen (die API filtert wahlweise nach 'created' oder 'price_review').
  woche                    text,

  roh                      jsonb not null,     -- inkl. order_stops mit Koordinaten
  sync_run_id              uuid references public.sync_runs(id) on delete set null,
  erstellt_am              timestamptz not null default now(),
  aktualisiert_am          timestamptz not null default now()
);

create index if not exists bolt_orders_woche_driver_idx
  on public.bolt_orders (woche, driver_uuid);
create index if not exists bolt_orders_company_created_idx
  on public.bolt_orders (company_id, order_created_at);
create index if not exists bolt_orders_status_idx
  on public.bolt_orders (woche, order_status);


-- ============================================================
-- 2. bolt_drivers  <- POST /fleetIntegration/v1/getDrivers
--    Momentaufnahme, kein Verlauf. Upsert ueberschreibt.
--    Liefert Bewertung, Sperrgrund und Kategorien - Daten, die heute nirgends stehen.
-- ============================================================
create table if not exists public.bolt_drivers (
  driver_uuid              text primary key,
  partner_uuid             text,
  company_id               bigint,
  first_name               text,
  last_name                text,
  email                    text,
  phone                    text,               -- Bruecke zu fahrer.telefon fuer die Erstzuordnung
  state                    text,               -- active | suspended | deactivated
  suspension_reason        text,
  has_cash_payment         boolean,
  driver_score             numeric,
  driver_rating            numeric,
  active_categories        text[],
  inactive_categories      text[],
  eligible_for_scheduled_ride boolean,

  -- aktuell zugewiesenes Fahrzeug
  active_vehicle_id        bigint,
  active_vehicle_reg       text,
  active_vehicle_model     text,

  roh                      jsonb not null,
  sync_run_id              uuid references public.sync_runs(id) on delete set null,
  erstellt_am              timestamptz not null default now(),
  aktualisiert_am          timestamptz not null default now()
);

create index if not exists bolt_drivers_phone_idx on public.bolt_drivers (phone);


-- ============================================================
-- 3. bolt_vehicles  <- POST /fleetIntegration/v1/getVehicles
--    Das ist der Fuhrpark, wie Bolt ihn kennt. Momentaufnahme, kein Verlauf.
--    PK ist 'id' (car_id), weil 'uuid' laut Spec null sein darf.
-- ============================================================
create table if not exists public.bolt_vehicles (
  id                       bigint primary key,
  uuid                     text,
  company_id               bigint,
  reg_number               text,               -- Kennzeichen -> Bruecke zu fahrer.kennzeichen
  model                    text,
  year                     integer,
  seats                    integer,
  color                    text,
  vin                      text,
  car_transport_licence_number text,
  state                    text,               -- active | suspended | deactivated
  suspension_reason        text,
  eligible_category_groups text[],

  roh                      jsonb not null,
  sync_run_id              uuid references public.sync_runs(id) on delete set null,
  erstellt_am              timestamptz not null default now(),
  aktualisiert_am          timestamptz not null default now()
);

create index if not exists bolt_vehicles_reg_idx on public.bolt_vehicles (reg_number);


-- ============================================================
-- 4. bolt_state_logs  <- POST /fleetIntegration/v1/getFleetStateLogs
--    Zustandswechsel je Fahrer ueber die Zeit: inactive / waiting_orders /
--    has_order / busy. Daraus kommen echte Arbeitszeiten und Leerlaufquoten.
--
--    ACHTUNG: Die API liefert hier KEINE eigene Zeilen-ID. (driver_uuid, created)
--    als Schluessel ist meine Wahl, nicht Bolts Zusage. Falls ein Fahrer zwei
--    Wechsel in derselben Sekunde hat, faellt einer weg.
-- ============================================================
create table if not exists public.bolt_state_logs (
  driver_uuid              text not null,
  created                  timestamptz not null,
  company_id               bigint,
  vehicle_uuid             text,
  state                    text,               -- inactive | waiting_orders | has_order | busy
  lat                      numeric,
  lng                      numeric,
  active_order_reference   text,
  woche                    text,

  roh                      jsonb not null,
  sync_run_id              uuid references public.sync_runs(id) on delete set null,
  erstellt_am              timestamptz not null default now(),

  primary key (driver_uuid, created)
);

create index if not exists bolt_state_logs_woche_idx
  on public.bolt_state_logs (woche, driver_uuid);


-- ============================================================
-- RLS: wie bei allen bestehenden Tabellen, anon ohne Rechte.
-- Dashboard-Nutzer lesen, geschrieben wird nur mit service_role (umgeht RLS).
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['bolt_orders', 'bolt_drivers', 'bolt_vehicles', 'bolt_state_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_users_read on public.%I', t);
    execute format(
      'create policy app_users_read on public.%I for select to authenticated using (is_app_user())', t);
  end loop;
end $$;


-- ============================================================
-- Fahrer-Zuordnung ueber die Bolt-ID statt ueber den Namen.
-- Erstzuordnung einmalig ueber die Telefonnummer gegen bolt_drivers,
-- danach ist Fuzzy-Matching Geschichte.
-- uber_driver_id kommt dazu, sobald die Uber-Kennung bekannt ist.
-- ============================================================
alter table public.fahrer
  add column if not exists bolt_driver_uuid text;

create unique index if not exists fahrer_bolt_driver_uuid_idx
  on public.fahrer (bolt_driver_uuid)
  where bolt_driver_uuid is not null;
