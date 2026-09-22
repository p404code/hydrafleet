-- Alle vier woechentlichen Laeufe, Montag frueh, UTC.
-- Am 2026-09-22 eingespielt (bolt_sync_zeitplan, uber_sync_zeitplan,
-- notion_sync_zeitplan). Diese Datei zeigt den Endstand im Zusammenhang.
--
-- Die Reihenfolge ist nicht beliebig:
--
--   alle 10 Min  notion-sync   Stammdaten laufend, damit eine Aenderung in
--                              Notion binnen Minuten in HYDRAlink steht
--   04:00        bolt-sync     Auftraege, Fahrer, Fahrzeuge
--   05:00        uber-sync     Zahlungen, Fahrzeuge, Fahrten. Spaeter als Bolt, weil
--                              Ubers Bericht 240 Minuten Frische-Zusage hat und
--                              die Abrechnungswoche erst Montag ~04:00 Wiener
--                              Zeit schliesst
--   02:20        Aufraeumen    erfolgreiche Notion-Laeufe aelter als 7 Tage
--                              loeschen - 144 Laeufe am Tag wuerden sync_runs
--                              sonst zumuellen. Fehler bleiben stehen.
--
-- Kein eigener Zuordnungs-Job noetig: die Zuordnung laeuft am Ende jedes
-- Notion-Laufs, also spaetestens 10 Minuten nach Bolt und Uber.
--
-- Der service_role-Key steht in keiner Job-Definition, sondern wird zur Laufzeit
-- aus dem Vault gelesen. Der letzte Eintrag braucht gar keinen: reines SQL.
do $do$
declare j text;
begin
  foreach j in array array['notion-sync-woechentlich', 'notion-sync-laufend',
                           'bolt-sync-woechentlich', 'uber-sync-woechentlich',
                           'zuordnung-nachziehen', 'sync-runs-aufraeumen']
  loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;

  perform cron.schedule('notion-sync-laufend', '*/10 * * * *', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/notion-sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb, timeout_milliseconds := 120000);
  $job$);

  perform cron.schedule('bolt-sync-woechentlich', '0 4 * * 1', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/bolt-sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb, timeout_milliseconds := 120000);
  $job$);

  perform cron.schedule('uber-sync-woechentlich', '0 5 * * 1', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb, timeout_milliseconds := 240000);
  $job$);

  perform cron.schedule('sync-runs-aufraeumen', '20 2 * * *', $job$
    delete from public.sync_runs r
    using public.verbindungen v
    where r.verbindung_id = v.id and v.anbieter = 'notion'
      and r.status = 'ok' and r.start < now() - interval '7 days';
  $job$);
end $do$;

-- 'notion' war im ersten Check-Constraint nicht vorgesehen, damals ging es nur
-- um Plattform-Umsaetze. Inzwischen ist Notion eine Verbindung wie jede andere.
alter table public.verbindungen drop constraint if exists verbindungen_anbieter_check;
alter table public.verbindungen
  add constraint verbindungen_anbieter_check
  check (anbieter in ('bolt', 'uber', 'mypos', 'notion'));
