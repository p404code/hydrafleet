-- ============================================================================
-- Kassabuch <- Wochenabrechnung
-- Datum: 2026-10-03
--
-- "Unterm Strich" (Summe auszahlung - lohn aller berechneten Fahrer einer Woche)
-- wird bar ausgezahlt. kassa_abrechnung_buchen(woche) traegt das ins Kassabuch ein:
--   1. eine Zeile "Abrechnung KW nn" = unterm Strich OHNE die Zu-/Abschlaege,
--   2. darunter jeden Zu-/Abschlag (abrechnung_posten) als eigene Zeile
--      (Zuschlag fuer den Fahrer = Ausgabe, Abzug = Einnahme).
-- Zusammen ergibt das genau "unterm Strich". Aendert sich die Abrechnung danach,
-- bucht derselbe Aufruf die Differenz als "Aenderung" nach. Ist die Woche schon
-- im Kassabuch, landet ein neuer Zu-/Abschlag sofort dort; wird er geloescht,
-- wird seine Zeile storniert. Kassieren (kassier_zahlungen) bleibt aussen vor.
--
-- Die Pruefsumme (kassa_summe) bleibt unveraendert - es gibt schon Buchungen.
-- quelle / woche_abr / posten_id sind Verweise; UPDATE ist per Trigger gesperrt.
--
-- Rollback: drop function kassa_abrechnung_buchen, kassa_abrechnung_stand, kassa_einfuegen;
--   posten_anlegen/posten_loeschen aus 2026-10-03-abrechnung-posten.sql, kassa_storno aus
--   2026-10-03-kassabuch-wochen.sql neu einspielen; Spalten koennen bleiben.
-- ============================================================================

alter table public.kassabuch
  add column if not exists quelle text not null default 'hand' check (quelle in ('hand', 'abrechnung', 'posten')),
  add column if not exists woche_abr text,
  add column if not exists posten_id bigint;
create index if not exists kassabuch_woche_abr on public.kassabuch (woche_abr) where woche_abr is not null;

-- Interne Buchung mit heutigem Datum auf den angemeldeten Benutzer.
create or replace function public.kassa_einfuegen(p_art text, p_betrag numeric, p_text text, p_quelle text,
                                                  p_woche_abr text, p_posten_id bigint, p_storno_von bigint)
returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch; v_wer text := public.kassa_wer(); v_heute date := (now() at time zone 'Europe/Vienna')::date; v_zu date;
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if not exists (select 1 from public.kassabuch where art = 'anfang' and datum <= v_heute) then
    raise exception 'Kassabuch: zuerst den Anfangsbestand setzen' using errcode = '22023';
  end if;
  select max(bis) into v_zu from public.kassa_abschluss;
  if v_zu is not null and v_heute <= v_zu then
    raise exception 'Kassabuch: die Woche bis % ist schon abgeschlossen – bitte morgen buchen', to_char(v_zu, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, storno_von, angelegt_von, quelle, woche_abr, posten_id)
  values (v_heute, p_art, round(p_betrag, 2), v_wer, p_text, p_storno_von, v_wer, p_quelle, p_woche_abr, p_posten_id)
  returning * into r;
  return r;
end $$;

create or replace function public.kassa_kw(p_woche text) returns text
language sql immutable as $$ select 'KW ' || coalesce(nullif(ltrim(substr(p_woche, 7), '0'), ''), '0') $$;

-- Stand je Abrechnungswoche: was bar auszuzahlen ist und was davon im Kassabuch steht.
-- Wochen ab der Woche vor dem Anfangsbestand; Sonderwochen (…k) bleiben aussen vor.
create or replace function public.kassa_abrechnung_stand()
returns table (woche text, fahrer integer, soll numeric, gebucht numeric, differenz numeric, uebernommen boolean, posten_offen integer)
language plpgsql security definer set search_path = public as $$
declare v_ab text;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select to_char(datum - 7, 'IYYY-"W"IW') into v_ab from public.kassabuch where art = 'anfang';
  if v_ab is null then return; end if;
  return query
  select s.woche, count(*)::integer,
         round(sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)), 2),
         coalesce(k.netto, 0), round(sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)), 2) - coalesce(k.netto, 0),
         coalesce(k.uebernommen, false),
         (select count(*)::integer from public.abrechnung_posten_offen o where o.woche = s.woche)
  from public.settlements s
  left join lateral (
    select sum(case kb.art when 'aus' then kb.betrag else -kb.betrag end) as netto,
           bool_or(kb.quelle = 'abrechnung') as uebernommen
    from public.kassabuch kb where kb.woche_abr = s.woche
  ) k on true
  where s.woche ~ '^\d{4}-W\d{2}$' and s.woche >= v_ab and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
  group by s.woche, k.netto, k.uebernommen
  order by s.woche;
end $$;

-- Abrechnung einer Woche ins Kassabuch: erstes Mal Summe + alle Zu-/Abschlaege, danach nur die Differenz.
create or replace function public.kassa_abrechnung_buchen(p_woche text) returns integer
language plpgsql security definer set search_path = public as $$
declare st record; p public.abrechnung_posten; v_posten numeric := 0; v_rest numeric; n integer := 0;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  lock table public.kassabuch in share row exclusive mode;
  select * into st from public.kassa_abrechnung_stand() x where x.woche = p_woche;
  if st.woche is null then raise exception 'Keine berechnete Abrechnung für %', p_woche using errcode = 'P0002'; end if;
  if st.posten_offen > 0 then
    raise exception 'In % sind Zu-/Abschläge nicht mehr in der Auszahlung – zuerst in der Abrechnung „Wieder einrechnen“', public.kassa_kw(p_woche) using errcode = '22023';
  end if;
  if not st.uebernommen then
    -- Zu-/Abschlaege der Woche, die noch nicht im Kassabuch stehen
    select coalesce(sum(betrag), 0) into v_posten from public.abrechnung_posten ap
      where ap.woche = p_woche and not exists (select 1 from public.kassabuch kb where kb.posten_id = ap.id);
    v_rest := st.differenz - v_posten;
    perform public.kassa_einfuegen(case when v_rest >= 0 then 'aus' else 'ein' end, abs(v_rest),
      'Abrechnung ' || public.kassa_kw(p_woche) || ' – bar unterm Strich, ' || st.fahrer || ' Fahrer' || case when v_posten <> 0 then ' (ohne Zu-/Abschläge)' else '' end,
      'abrechnung', p_woche, null, null);
    n := 1;
    for p in select * from public.abrechnung_posten ap where ap.woche = p_woche
               and not exists (select 1 from public.kassabuch kb where kb.posten_id = ap.id) order by ap.id loop
      perform public.kassa_einfuegen(case when p.betrag > 0 then 'aus' else 'ein' end, abs(p.betrag),
        public.kassa_kw(p_woche) || ' · ' || p.fahrer_name || ': ' || p.text, 'posten', p_woche, p.id, null);
      n := n + 1;
    end loop;
  elsif st.differenz <> 0 then
    perform public.kassa_einfuegen(case when st.differenz > 0 then 'aus' else 'ein' end, abs(st.differenz),
      'Abrechnung ' || public.kassa_kw(p_woche) || ' – Änderung (neu ' || replace(to_char(st.soll, 'FM999999990.00'), '.', ',') || ' €)',
      'abrechnung', p_woche, null, null);
    n := 1;
  end if;
  return n;
end $$;

create or replace function public.posten_anlegen(p_woche text, p_fahrer_name text, p_betrag numeric, p_text text)
returns public.abrechnung_posten
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_posten;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_fahrer_name is null or p_fahrer_name = '__TRANSFER__'
     or not exists (select 1 from public.settlements where woche = p_woche and fahrer_name = p_fahrer_name) then
    raise exception 'Keine Abrechnung für % in %', p_fahrer_name, p_woche using errcode = 'P0002';
  end if;
  if coalesce(round(p_betrag, 2), 0) = 0 then raise exception 'Betrag fehlt' using errcode = '22023'; end if;
  if btrim(coalesce(p_text, '')) = '' then raise exception 'Text fehlt' using errcode = '22023'; end if;
  insert into public.abrechnung_posten (woche, fahrer_name, betrag, text, angelegt_von)
  values (p_woche, p_fahrer_name, round(p_betrag, 2), btrim(p_text),
          coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  returning * into r;
  perform public.posten_anwenden(p_woche, p_fahrer_name);
  -- Steht die Woche schon im Kassabuch, gehoert der Posten sofort dazu.
  if exists (select 1 from public.kassabuch where quelle = 'abrechnung' and woche_abr = p_woche) then
    perform public.kassa_einfuegen(case when r.betrag > 0 then 'aus' else 'ein' end, abs(r.betrag),
      public.kassa_kw(p_woche) || ' · ' || r.fahrer_name || ': ' || r.text, 'posten', p_woche, r.id, null);
  end if;
  return r;
end $$;

create or replace function public.posten_loeschen(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_posten; k public.kassabuch;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  delete from public.abrechnung_posten where id = p_id returning * into r;
  if r.id is null then raise exception 'Posten nicht gefunden' using errcode = 'P0002'; end if;
  perform public.posten_anwenden(r.woche, r.fahrer_name);
  select * into k from public.kassabuch kb where kb.posten_id = p_id and kb.storno_von is null
    and not exists (select 1 from public.kassabuch x where x.storno_von = kb.id);
  if k.id is not null then
    perform public.kassa_einfuegen(case k.art when 'ein' then 'aus' else 'ein' end, k.betrag,
      'Storno Nr. ' || k.nr || ' – gelöscht: ' || k.text, 'posten', k.woche_abr, p_id, k.id);
  end if;
end $$;

-- Von Hand storniert werden nur Handbuchungen; Zeilen aus der Abrechnung folgen der Abrechnung.
create or replace function public.kassa_storno(p_id bigint) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare o public.kassabuch; r public.kassabuch; v_wer text := public.kassa_wer();
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into o from public.kassabuch where id = p_id;
  if o.id is null then raise exception 'Buchung nicht gefunden' using errcode = 'P0002'; end if;
  if o.art = 'anfang' then raise exception 'Der Anfangsbestand wird nicht storniert' using errcode = '22023'; end if;
  if o.quelle <> 'hand' then
    raise exception 'Diese Zeile kommt aus der Abrechnung – dort ändern, das Kassabuch zieht nach' using errcode = '22023';
  end if;
  if o.storno_von is not null then raise exception 'Ein Storno wird nicht storniert' using errcode = '22023'; end if;
  if exists (select 1 from public.kassabuch where storno_von = p_id) then
    raise exception 'Schon storniert' using errcode = '23505';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, storno_von, angelegt_von)
  values ((now() at time zone 'Europe/Vienna')::date, case o.art when 'ein' then 'aus' else 'ein' end, o.betrag, v_wer,
          'Storno Nr. ' || o.nr || ' vom ' || to_char(o.datum, 'DD.MM.') || ' (' || o.name || '): ' || coalesce(o.text, ''), o.id, v_wer)
  returning * into r;
  return r;
end $$;

revoke all on function public.kassa_einfuegen(text, numeric, text, text, text, bigint, bigint), public.kassa_kw(text),
  public.kassa_abrechnung_stand(), public.kassa_abrechnung_buchen(text) from public, anon, authenticated;
grant execute on function public.kassa_abrechnung_stand(), public.kassa_abrechnung_buchen(text) to authenticated;
