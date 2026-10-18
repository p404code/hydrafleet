-- ============================================================================
-- Automatische Abrechnung: Status fuers Dashboard + automatische Freigabe (Betreiber 19.10.2026:
-- "eine art status fuer die api abrechnung … soll morgen frueh schon in die uebersicht als 42 + in die apps")
-- Datum: 2026-10-19
--
-- abrechnung_auto_freigeben(woche): gibt eine Woche frei, die abrechnung_api_schreiben geschrieben hat
--   (freigegeben_von = 'Automatik'). Ist sie schon freigegeben (von Hand), passiert nichts. Danach sehen die Fahrer
--   die Woche in der App (fahrer_app_abrechnungen) und sie ist ueberweisbar.
-- montag_frueh() ruft das direkt nach dem Schreiben auf.
-- abrechnung_api_status(woche default letzte abgeschlossene Woche in Wien): alles fuer die Statuszeile.
-- Rollback: montag_frueh aus 2026-10-18-abrechnung-api-automatisch.sql neu einspielen; drop function abrechnung_api_status,
--   abrechnung_auto_freigeben;
-- ============================================================================

create or replace function public.abrechnung_auto_freigeben(p_woche text) returns text
language plpgsql security definer set search_path = public as $$
declare v_n integer; v_summe numeric;
begin
  if not exists (select 1 from public.abrechnung_api_laeufe where woche = p_woche and ergebnis = 'geschrieben') then return 'nicht_geschrieben'; end if;
  if exists (select 1 from public.abrechnung_freigaben where woche = p_woche) then return 'schon_frei'; end if;
  select count(*), round(coalesce(sum(auszahlung - coalesce(lohn, 0)), 0), 2) into v_n, v_summe
    from public.settlements where woche = p_woche and status = 'berechnet';
  if v_n = 0 then return 'keine_zeilen'; end if;
  insert into public.abrechnung_freigaben (woche, freigegeben_von, anzahl, summe) values (p_woche, 'Automatik', v_n, v_summe)
  on conflict (woche) do nothing;
  return 'freigegeben';
end $$;

create or replace function public.montag_frueh() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_jetzt timestamp := now() at time zone 'Europe/Vienna';
  t time := v_jetzt::time;
  w text := to_char(v_jetzt::date - 1, 'IYYY-"W"IW');
  h jsonb;
begin
  if extract(isodow from v_jetzt) <> 1 then return; end if;
  h := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'));
  if t >= '04:10' and t < '04:15' then
    perform net.http_post(url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/bolt-sync', headers := h,
      body := jsonb_build_object('woche', w), timeout_milliseconds := 120000);
  end if;
  if (t >= '04:15' and t < '04:20') or (t >= '04:25' and t < '04:30') or (t >= '04:40' and t < '04:45') then
    perform net.http_post(url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync', headers := h,
      body := jsonb_build_object('woche', w, 'nur_offene', true), timeout_milliseconds := 160000);
  end if;
  if (t >= '05:00' and t < '05:05') or (t >= '05:30' and t < '05:35') or (t >= '06:00' and t < '06:05') or (t >= '07:15' and t < '07:20') then
    perform public.abrechnung_api_schreiben(w);
    perform public.abrechnung_auto_freigeben(w);
  end if;
end $$;

create or replace function public.abrechnung_api_status(p_woche text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_heute date := (now() at time zone 'Europe/Vienna')::date;
  w text := coalesce(p_woche, to_char(v_heute - extract(isodow from v_heute)::integer, 'IYYY-"W"IW'));
  v_mo date := to_date(left(w, 8), 'IYYY-"W"IW');
  v_lauf_tag date := v_mo + 7;      -- Montag nach der Woche
  r jsonb;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select jsonb_build_object(
    'woche', w,
    'lauf_geplant', (v_lauf_tag::text || ' 05:00'),
    'bolt', jsonb_build_object('zeilen', (select count(*) from public.bolt_orders where woche = w),
              'zuletzt', (select max(s.ende) from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
                          where v.anbieter = 'bolt' and s.zeitraum_von = v_mo and s.status = 'ok' and coalesce(s.anzahl, 0) > 0),
              'fehler', (select s.fehler from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
                         where v.anbieter = 'bolt' and s.zeitraum_von = v_mo order by s.start desc limit 1)),
    'uber', jsonb_build_object('zeilen', (select count(*) from public.uber_reports where woche = w and umsaetze is not null),
              'zuletzt', (select max(s.ende) from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
                          where v.anbieter = 'uber' and s.zeitraum_von = v_mo and s.status = 'ok' and coalesce(s.anzahl, 0) > 0),
              'fehler', (select s.fehler from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
                         where v.anbieter = 'uber' and s.zeitraum_von = v_mo and s.fehler is distinct from 'nur Verbindungstest'
                         order by s.start desc limit 1)),
    'mypos', (select jsonb_build_object('terminals', count(*), 'summe', sum(betrag), 'ohne_fahrer', count(*) filter (where fahrer_id is null),
                                        'letzte_buchung', max(letzte_buchung), 'datei', max(datei))
              from public.mypos_umsaetze where woche = w having count(*) > 0),
    'mypos_csv', (select sum(mypos_summe) from public.settlements where woche = w and fahrer_name not like '\_\_%'),
    'abrechnung', (select to_jsonb(l) from public.abrechnung_api_laeufe l where l.woche = w),
    'zeilen', (select count(*) from public.settlements where woche = w and fahrer_name not like '\_\_%'),
    'freigabe', (select jsonb_build_object('am', f.freigegeben_am, 'von', f.freigegeben_von) from public.abrechnung_freigaben f where f.woche = w)
  ) into r;
  return r;
end $$;

revoke all on function public.abrechnung_auto_freigeben(text), public.montag_frueh() from public, anon, authenticated;
grant execute on function public.abrechnung_auto_freigeben(text), public.montag_frueh() to service_role;
revoke all on function public.abrechnung_api_status(text) from public, anon;
grant execute on function public.abrechnung_api_status(text) to authenticated;
