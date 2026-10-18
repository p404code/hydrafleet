-- ============================================================================
-- Automatische Wochenabrechnung aus Bolt + Uber (Betreiber 18.10.2026: "morgen um 5:00 die automatische Abrechnung,
-- als Uebersicht rein wie nach einem CSV-Upload"). myPOS fehlt noch (neues myPOS-Konto folgt) -> kommt per CSV-Upload.
-- Datum: 2026-10-18
--
-- abrechnung_api_schreiben(woche) schreibt die Zeilen aus api_abrechnung nach settlements - genau dann, wenn
--   * fuer die Woche noch KEINE Abrechnung existiert (CSV hochgeladen oder frueherer Lauf -> nichts anfassen),
--   * Bolt UND Uber fuer die Woche gesynct sind.
-- Ein spaeterer CSV-Upload ueberschreibt die Zeilen (AbrechnungsBot: upsert auf woche + fahrer_name) - die CSV gilt.
-- Konten ohne Fahrer kommen wie beim Bot als WARNUNG_KEIN_FAHRER (zaehlen nicht zur Auszahlung).
-- montag_frueh() laeuft montags alle 5 Minuten und entscheidet nach WIENER Uhrzeit (Sommer-/Winterzeit egal):
--   04:10 Bolt-Sync · 04:15/04:25/04:40 Uber-Sync · 05:00 Abrechnung (Wiederholung 05:30, 06:00, 07:15, falls unvollstaendig).
-- Die bisherigen Zeitplaene (Bolt 04:00 UTC, Uber 05:00 UTC) bleiben als spaetere Auffrischung.
--
-- Rollback: select cron.unschedule('montag-frueh'); drop function montag_frueh, abrechnung_api_schreiben;
--   drop table abrechnung_api_laeufe;  (geschriebene settlements-Zeilen: delete ... where woche = 'JJJJ-Wnn' vor dem CSV-Upload)
-- ============================================================================

create table if not exists public.abrechnung_api_laeufe (
  woche        text primary key,
  zeit         timestamptz not null default now(),
  ergebnis     text not null check (ergebnis in ('geschrieben', 'schon_da', 'unvollstaendig')),
  anzahl       integer,
  ohne_fahrer  integer,
  summe        numeric(12,2),
  hinweis      text
);
alter table public.abrechnung_api_laeufe enable row level security;
revoke all on public.abrechnung_api_laeufe from public, anon, authenticated;
grant select on public.abrechnung_api_laeufe to authenticated;
drop policy if exists buero_liest on public.abrechnung_api_laeufe;
create policy buero_liest on public.abrechnung_api_laeufe for select to authenticated using (public.is_app_user());

create or replace function public.abrechnung_api_schreiben(p_woche text, p_probe boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; v_ohne integer := 0; v_summe numeric := 0; v_bolt boolean; v_uber boolean; v_alt public.abrechnung_api_laeufe;
begin
  if p_woche is null or p_woche !~ '^\d{4}-W\d{2}$' then raise exception 'Woche ungültig: %', p_woche using errcode = '22023'; end if;
  select * into v_alt from public.abrechnung_api_laeufe where woche = p_woche;
  if v_alt.ergebnis = 'geschrieben' and not p_probe then return 'geschrieben'; end if;

  if exists (select 1 from public.settlements where woche = p_woche and fahrer_name not like '\_\_%') and not p_probe then
    insert into public.abrechnung_api_laeufe (woche, ergebnis, hinweis) values (p_woche, 'schon_da', 'Abrechnung war schon da (CSV) – nichts geändert')
    on conflict (woche) do update set zeit = now(), ergebnis = excluded.ergebnis, hinweis = excluded.hinweis;
    return 'schon_da';
  end if;

  v_bolt := exists (select 1 from public.bolt_orders where woche = p_woche);
  v_uber := exists (select 1 from public.uber_reports where woche = p_woche and umsaetze is not null);
  if not (v_bolt and v_uber) then
    if not p_probe then
      insert into public.abrechnung_api_laeufe (woche, ergebnis, hinweis)
      values (p_woche, 'unvollstaendig', 'Noch nicht gesynct: ' || concat_ws(', ', case when not v_bolt then 'Bolt' end, case when not v_uber then 'Uber' end))
      on conflict (woche) do update set zeit = now(), ergebnis = excluded.ergebnis, hinweis = excluded.hinweis;
    end if;
    return 'unvollstaendig';
  end if;

  if p_probe then
    select count(*), coalesce(sum(a.auszahlung), 0) into v_n, v_summe from public.api_abrechnung a where a.woche = p_woche and a.fahrer_id is not null;
    select count(distinct a.fahrer) into v_ohne from public.api_abrechnung a where a.woche = p_woche and a.befund = 'Konto ohne Fahrer';
    return 'probe: ' || v_n || ' Fahrer, ' || v_ohne || ' Konten ohne Fahrer, Summe Auszahlung ' || round(v_summe, 2);
  end if;

  -- Fahrer: Werte wie der Bot sie schreibt (Telefon aus dem Fahrer-Stamm -> settlement_fahrer ordnet eindeutig zu)
  insert into public.settlements (woche, fahrer_name, telefon, mietmodell, miete, bolt_brutto, bolt_auszahlung, uber_fahrpreis,
                                  uber_auszahlung, mypos_summe, bruttoumsatz_gesamt, wir_bekommen, prozent_abzug, abzug_gesamt,
                                  auszahlung, status)
  select a.woche, f.name, f.telefon, a.mietmodell, coalesce(a.miete, 0), coalesce(a.bolt_brutto, 0), coalesce(a.bolt_auszahlung, 0),
         coalesce(a.uber_fahrpreis, 0), coalesce(a.uber_auszahlung, 0), 0, coalesce(a.bruttoumsatz_gesamt, 0), coalesce(a.wir_bekommen, 0),
         coalesce(a.prozent_abzug, 0), coalesce(a.abzug_gesamt, 0), coalesce(a.auszahlung, 0), 'berechnet'
  from public.api_abrechnung a
  join public.fahrer f on f.id = a.fahrer_id
  where a.woche = p_woche and a.fahrer_id is not null
  on conflict (woche, fahrer_name) do nothing;
  get diagnostics v_n = row_count;

  -- Konten ohne Fahrer (wie der Bot: Warnung, keine Pauschale, keine Auszahlung ueber HYDRAlink)
  insert into public.settlements (woche, fahrer_name, bolt_brutto, bolt_auszahlung, uber_fahrpreis, uber_auszahlung,
                                  bruttoumsatz_gesamt, wir_bekommen, auszahlung, status)
  select p_woche, a.fahrer, sum(coalesce(a.bolt_brutto, 0)), sum(coalesce(a.bolt_auszahlung, 0)), sum(coalesce(a.uber_fahrpreis, 0)),
         sum(coalesce(a.uber_auszahlung, 0)), sum(coalesce(a.bolt_brutto, 0) + coalesce(a.uber_fahrpreis, 0)),
         sum(coalesce(a.bolt_auszahlung, 0) + coalesce(a.uber_auszahlung, 0)), sum(coalesce(a.bolt_auszahlung, 0) + coalesce(a.uber_auszahlung, 0)),
         'WARNUNG_KEIN_FAHRER'
  from public.api_abrechnung a
  where a.woche = p_woche and a.befund = 'Konto ohne Fahrer' and coalesce(a.fahrer, '') <> ''
  group by a.fahrer
  on conflict (woche, fahrer_name) do nothing;
  get diagnostics v_ohne = row_count;

  select coalesce(sum(auszahlung), 0) into v_summe from public.settlements where woche = p_woche and status = 'berechnet';
  insert into public.abrechnung_api_laeufe (woche, ergebnis, anzahl, ohne_fahrer, summe, hinweis)
  values (p_woche, 'geschrieben', v_n, v_ohne, v_summe, 'Automatisch aus Bolt + Uber – myPOS fehlt, kommt mit dem CSV-Upload')
  on conflict (woche) do update set zeit = now(), ergebnis = excluded.ergebnis, anzahl = excluded.anzahl,
    ohne_fahrer = excluded.ohne_fahrer, summe = excluded.summe, hinweis = excluded.hinweis;
  return 'geschrieben: ' || v_n || ' Fahrer, ' || v_ohne || ' Konten ohne Fahrer';
end $$;

-- Montag frueh nach Wiener Uhr. Woche = ISO-Woche von gestern (Sonntag) in Wien.
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
  end if;
end $$;

revoke all on function public.abrechnung_api_schreiben(text, boolean), public.montag_frueh() from public, anon, authenticated;
grant execute on function public.abrechnung_api_schreiben(text, boolean), public.montag_frueh() to service_role;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'montag-frueh') then perform cron.unschedule('montag-frueh'); end if;
  -- montags 01:00-06:55 UTC alle 5 Minuten = Wien 02:00-08:55 (Winter) bzw. 03:00-08:55 (Sommer); montag_frueh() filtert
  perform cron.schedule('montag-frueh', '*/5 1-6 * * 1', $job$ select public.montag_frueh(); $job$);
end $do$;
