-- Ueberweisungshistorie taeglich aus Revolut holen (revolut-auszahlung, Aktion buchungen_abrufen).
-- Datum: 2026-10-18. Der erste Lauf holt die Historie seitenweise, bis revolut_abruf.historie_fertig.
-- Rollback: select cron.unschedule('revolut-buchungen-taeglich');
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'revolut-buchungen-taeglich') then
    perform cron.unschedule('revolut-buchungen-taeglich');
  end if;
  perform cron.schedule('revolut-buchungen-taeglich', '45 5 * * *', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/revolut-auszahlung',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"aktion":"buchungen_abrufen"}'::jsonb, timeout_milliseconds := 150000);
  $job$);
end $do$;
