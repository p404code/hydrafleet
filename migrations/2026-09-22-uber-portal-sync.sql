-- Uber ueber das Fleet-Portal. Am 2026-09-22 eingespielt und in
-- supabase_migrations registriert (uber_rohdaten, verbindung_anlegen_rpc,
-- uber_sync_zeitplan).
--
-- Kein offizieller API-Zugang: die offiziellen Echtzeit-Endpunkte reichen nur
-- 24 Stunden zurueck und taugen fuer eine Wochenabrechnung nicht. Stattdessen
-- wird die interne Schnittstelle von fleethub.uber.com mit einer gespeicherten
-- Anmeldesitzung benutzt - bewusste Entscheidung des Betreibers.
--
-- Spalten stammen 1:1 aus dem echten Bericht
-- "20260914-20260921-payments_driver-EH_Limousinenservice_KG.csv" (22 Spalten)
-- und aus der Antwort von /api/getDrivers. Nichts geraten.

-- === Verbindung samt Vault-Secret in einem Schritt ===
-- Zweck: Zugangsdaten sollen nie durch eine Datei, ein Protokoll oder einen
-- Chatverlauf wandern. Der Aufrufer schickt sie direkt hierher; zurueck kommt
-- nur die Verbindungs-ID. Wird auch fuers Erneuern abgelaufener Sitzungen genutzt.
create or replace function public.verbindung_setzen(
  p_anbieter    text,
  p_firma       text,
  p_externe_id  text,
  p_secret      jsonb,
  p_bezeichnung text default null
) returns uuid
language plpgsql security definer set search_path = public, vault as $$
declare
  v_id uuid; v_secret uuid;
  v_name text := coalesce(p_bezeichnung, p_anbieter || '_' || coalesce(p_firma, 'alle'));
begin
  select id, vault_secret_id into v_id, v_secret
    from public.verbindungen
   where anbieter = p_anbieter and coalesce(firma, '') = coalesce(p_firma, '');

  if v_secret is null then
    select vault.create_secret(p_secret::text, v_name,
      'Zugang ' || p_anbieter || ' ' || coalesce(p_firma, '')) into v_secret;
  else
    perform vault.update_secret(v_secret, p_secret::text);
  end if;

  if v_id is null then
    insert into public.verbindungen (anbieter, firma, vault_secret_id, externe_id)
    values (p_anbieter, p_firma, v_secret, p_externe_id) returning id into v_id;
  else
    update public.verbindungen
       set externe_id = coalesce(p_externe_id, externe_id),
           status = 'aktiv', letzter_fehler = null
     where id = v_id;
  end if;
  return v_id;
end $$;

revoke all on function public.verbindung_setzen(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.verbindung_setzen(text, text, text, jsonb, text) to service_role;

-- === Fahrer ===
-- Der Bericht enthaelt die Fahrer-UUID in Spalte 1. Damit faellt das
-- Namens-Matching fuer Uber weg, genau wie bei Bolt ueber driver_uuid.
create table if not exists public.uber_drivers (
  driver_uuid      text primary key,
  org_id           text,
  vorname          text,
  nachname         text,
  email            text,
  telefon          text,              -- countryCode + number, Bruecke zu fahrer.telefon
  fahrer_id        integer references public.fahrer(id),
  zuordnung_quelle text,              -- telefon | name | manuell
  roh              jsonb not null,    -- inkl. assignedVehicles, roles, documentRequirements
  sync_run_id      uuid references public.sync_runs(id) on delete set null,
  erstellt_am      timestamptz not null default now(),
  aktualisiert_am  timestamptz not null default now()
);
create index if not exists uber_drivers_telefon_idx on public.uber_drivers (telefon);
create index if not exists uber_drivers_fahrer_idx  on public.uber_drivers (fahrer_id);

-- === Wochenbericht je Fahrer ===
-- Schluessel ist Firma + Zeitraum + Fahrer, nicht die report_id: ein erneut
-- angeforderter Bericht ueberschreibt damit sauber, statt zu doppeln.
create table if not exists public.uber_reports (
  org_id                text not null,
  zeitraum_von          date not null,
  zeitraum_bis          date not null,
  driver_uuid           text not null,
  org_name              text,
  woche                 text,
  vorname               text,
  nachname              text,

  gezahlt               numeric,  -- An dein Unternehmen gezahlt
  umsaetze              numeric,  -- … : Deine Umsaetze
  bargeld               numeric,  -- … : Fahrtguthaben : Auszahlungen : Eingenommenes Bargeld
  fahrpreis             numeric,  -- … : Deine Umsaetze : Fahrpreis
  steuern               numeric,  -- … : Deine Umsaetze : Steuern
  fahrpreis_basis       numeric,
  stornierung           numeric,
  dynamische_anpassung  numeric,
  steuer_auf_fahrpreis  numeric,
  wartezeit_abholung    numeric,
  servicegebuehr        numeric,
  steuer_servicegebuehr numeric,
  trinkgeld             numeric,
  flughafen_parkgebuehr numeric,
  anpassung             numeric,
  buchungsgebuehr       numeric,
  reservierungsgebuehr  numeric,
  bankueberweisung      numeric,  -- …:Fahrtguthaben:Auszahlungen:Auf Bankkonto ueberwiesen
  zeit_zwischenstopp    numeric,

  -- Zeilen mit Wert in bankueberweisung sind Ubers Sammelposten, kein Fahrer.
  -- Die bestehende Berechnung erkennt sie am Namen; hier erledigt das die Spalte.
  ist_sammelposten      boolean generated always as (coalesce(bankueberweisung, 0) <> 0) stored,

  report_id             text,
  roh                   jsonb not null,
  sync_run_id           uuid references public.sync_runs(id) on delete set null,
  erstellt_am           timestamptz not null default now(),
  aktualisiert_am       timestamptz not null default now(),

  primary key (org_id, zeitraum_von, zeitraum_bis, driver_uuid)
);
create index if not exists uber_reports_woche_idx  on public.uber_reports (woche, driver_uuid);
create index if not exists uber_reports_driver_idx on public.uber_reports (driver_uuid);

-- === RLS wie ueberall, anon ohne Rechte ===
do $$
declare t text;
begin
  foreach t in array array['uber_drivers', 'uber_reports']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_users_read on public.%I', t);
    execute format(
      'create policy app_users_read on public.%I for select to authenticated using (is_app_user())', t);
  end loop;
end $$;

-- === Zeitplan: montags 05:00 UTC, eine Stunde nach Bolt ===
-- Spaeter als Bolt, weil Ubers Zahlungsbericht eine Frische-Zusage von 240 Minuten
-- hat und die Abrechnungswoche erst Montag gegen 04:00 Wiener Zeit schliesst.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'uber-sync-woechentlich') then
    perform cron.unschedule('uber-sync-woechentlich');
  end if;
  perform cron.schedule(
    'uber-sync-woechentlich', '0 5 * * 1',
    $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
    $job$
  );
end $do$;
