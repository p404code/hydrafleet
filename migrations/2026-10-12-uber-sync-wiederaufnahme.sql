-- uber-sync: dreimal am Montag statt einmal.
--
-- Ubers Zahlungsbericht braucht am Montag frueh laenger, als eine Edge Function
-- leben darf (12.10.2026: 213 s gegen 150 s) - der Lauf wurde hart beendet,
-- KW41 fehlte, sync_runs blieb auf 'laeuft'. Seit uber-sync v8 wartet ein Lauf
-- nur bis zu seiner Frist und der naechste nimmt dieselben Berichte wieder auf.
--
--   05:00  fordert die Berichte an, holt was fertig ist
--   05:10  holt den Rest (nur_offene: fertige Verbindungen bleiben liegen)
--   05:30  Reserve
--
-- ERST EINSPIELEN, WENN uber-sync v8 DEPLOYT IST: die alte Fassung kennt
-- nur_offene nicht und wuerde dreimal neu anfordern.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'uber-sync-woechentlich') then
    perform cron.unschedule('uber-sync-woechentlich');
  end if;

  perform cron.schedule('uber-sync-woechentlich', '0,10,30 5 * * 1', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"nur_offene": true}'::jsonb, timeout_milliseconds := 160000);
  $job$);
end
$do$;

-- Die vom Zeitlimit abgeschnittenen Laeufe stehen noch auf 'laeuft'.
update public.sync_runs r
   set status = 'fehler', ende = r.start + interval '150 seconds',
       fehler = 'abgebrochen: Zeitlimit der Edge Function (150 s)'
  from public.verbindungen v
 where v.id = r.verbindung_id and v.anbieter = 'uber'
   and r.status = 'laeuft' and r.start < now() - interval '10 minutes';
