-- ============================================================================
-- Kassabuch: Anfangsbestand korrigieren
-- Datum: 2026-10-03
--
-- Der Anfangsbestand selbst bleibt stehen (nichts wird geaendert). Eine Korrektur
-- ist eine eigene, sichtbare Zeile (quelle = 'anfang') am Tag des Anfangsbestands:
-- "Anfangsbestand korrigiert: alt X, neu Y". Sie zaehlt zum Anfangsbestand, nicht
-- zu Einnahmen/Ausgaben. Moeglich nur, solange noch keine Woche abgeschlossen ist -
-- danach steht der Bestand in einem Abschluss und ist fest.
--
-- Rollback: drop function kassa_anfang_korrigieren; kassa_abschliessen aus
--   2026-10-03-kassabuch-wochen.sql neu einspielen.
-- ============================================================================

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.kassabuch'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%quelle%' loop
    execute format('alter table public.kassabuch drop constraint %I', c);
  end loop;
end $$;
alter table public.kassabuch add constraint kassabuch_quelle_check check (quelle in ('hand', 'abrechnung', 'posten', 'anfang'));

create or replace function public.kassa_anfang_korrigieren(p_betrag numeric) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare a public.kassabuch; r public.kassabuch; v_wer text := public.kassa_wer(); v_alt numeric; v_diff numeric;
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_betrag is null or p_betrag < 0 then raise exception 'Betrag fehlt' using errcode = '22023'; end if;
  lock table public.kassabuch in share row exclusive mode;
  select * into a from public.kassabuch where art = 'anfang';
  if a.id is null then raise exception 'Es gibt noch keinen Anfangsbestand' using errcode = '22023'; end if;
  if exists (select 1 from public.kassa_abschluss) then
    raise exception 'Es ist schon eine Woche abgeschlossen – der Anfangsbestand ist fest' using errcode = '22023';
  end if;
  select a.betrag + coalesce(sum(case when art = 'aus' then -betrag else betrag end), 0) into v_alt
    from public.kassabuch where quelle = 'anfang';
  v_diff := round(p_betrag, 2) - v_alt;
  if v_diff = 0 then raise exception 'Der Anfangsbestand ist schon %', replace(to_char(v_alt, 'FM999999990.00'), '.', ',') using errcode = '22023'; end if;
  insert into public.kassabuch (datum, art, betrag, name, text, angelegt_von, quelle)
  values (a.datum, case when v_diff > 0 then 'ein' else 'aus' end, abs(v_diff), v_wer,
          'Anfangsbestand korrigiert: alt ' || replace(to_char(v_alt, 'FM999999990.00'), '.', ',') || ' €, neu '
            || replace(to_char(round(p_betrag, 2), 'FM999999990.00'), '.', ',') || ' €', v_wer, 'anfang')
  returning * into r;
  return r;
end $$;

-- Abschluss: Korrekturen des Anfangsbestands zaehlen zum Anfangsbestand, nicht zu Ein/Aus.
create or replace function public.kassa_abschliessen(p_woche text, p_gezaehlt numeric) returns public.kassa_abschluss
language plpgsql security definer set search_path = public as $$
declare r public.kassa_abschluss; v_wer text := public.kassa_wer(); v_heute date := (now() at time zone 'Europe/Vienna')::date;
        v_von date; v_bis date; v_zu date; v_anfang numeric; v_ein numeric; v_aus numeric; v_n integer; v_nr integer; v_ps text; v_offen date;
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if coalesce(p_woche, '') !~ '^\d{4}-W\d{2}$' then raise exception 'Ungültige Woche: %', p_woche using errcode = '22023'; end if;
  v_von := to_date(p_woche, 'IYYY-"W"IW');
  if to_char(v_von, 'IYYY-"W"IW') <> p_woche then raise exception 'Ungültige Woche: %', p_woche using errcode = '22023'; end if;
  v_bis := v_von + 6;
  if p_gezaehlt is null or p_gezaehlt < 0 then raise exception 'Bitte den gezählten Betrag eintragen' using errcode = '22023'; end if;
  if v_heute < v_bis then raise exception 'KW % läuft noch bis %', p_woche, to_char(v_bis, 'DD.MM.YYYY') using errcode = '22023'; end if;
  lock table public.kassabuch in share row exclusive mode;
  if not exists (select 1 from public.kassabuch where art = 'anfang' and datum <= v_bis) then
    raise exception 'Vor oder in KW % gibt es keinen Anfangsbestand', p_woche using errcode = '22023';
  end if;
  select max(bis) into v_zu from public.kassa_abschluss;
  if v_zu is not null and v_von <= v_zu then raise exception 'KW % ist schon abgeschlossen', p_woche using errcode = '23505'; end if;
  select min(datum) into v_offen from public.kassabuch where datum < v_von and (v_zu is null or datum > v_zu);
  if v_offen is not null then
    raise exception 'Zuerst KW % abschließen', to_char(v_offen, 'IYYY-"W"IW') using errcode = '22023';
  end if;
  select coalesce(sum(case when art = 'aus' then -betrag else betrag end), 0) into v_anfang
    from public.kassabuch where datum < v_von or ((art = 'anfang' or quelle = 'anfang') and datum <= v_bis);
  select coalesce(sum(betrag) filter (where art = 'ein'), 0), coalesce(sum(betrag) filter (where art = 'aus'), 0),
         count(*) filter (where art <> 'anfang')
    into v_ein, v_aus, v_n from public.kassabuch where datum between v_von and v_bis and quelle <> 'anfang';
  select nr, pruefsumme into v_nr, v_ps from public.kassabuch order by nr desc limit 1;
  insert into public.kassa_abschluss (woche, von, bis, anfangsbestand, einnahmen, ausgaben, endbestand, gezaehlt, differenz,
                                      buchungen, letzte_nr, letzte_pruefsumme, abgeschlossen_von)
  values (p_woche, v_von, v_bis, v_anfang, v_ein, v_aus, v_anfang + v_ein - v_aus, round(p_gezaehlt, 2),
          round(p_gezaehlt, 2) - (v_anfang + v_ein - v_aus), v_n, v_nr, v_ps, v_wer)
  returning * into r;
  return r;
end $$;

revoke all on function public.kassa_anfang_korrigieren(numeric) from public, anon;
grant execute on function public.kassa_anfang_korrigieren(numeric) to authenticated;
