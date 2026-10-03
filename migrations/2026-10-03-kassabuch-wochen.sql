-- ============================================================================
-- Kassabuch v2: je Kalenderwoche, mit Wochenabschluss und Uebertrag; abgesichert
-- Datum: 2026-10-03 (baut auf 2026-10-03-kassabuch.sql auf, Tabelle war noch leer)
--
-- * name = angemeldeter Benutzer (app_metadata.app_name), nicht mehr frei waehlbar.
-- * Jede Buchung bekommt eine lueckenlose Nummer (nr) und eine Pruefsumme, in die
--   die Pruefsumme der Buchung davor einfliesst. Wer eine alte Zeile aendert,
--   bricht die Kette ab dort - kassa_pruefen() findet die Stelle.
-- * UPDATE, DELETE und TRUNCATE sind per Trigger gesperrt (auch fuer das SQL-Fenster).
-- * kassa_abschliessen(woche, gezaehlt) haelt Anfangsbestand, Einnahmen, Ausgaben,
--   Endbestand und den gezaehlten Betrag fest. Danach nimmt die Woche keine
--   Buchung mehr an; der Endbestand ist der Uebertrag in die naechste Woche.
-- * Woche = ISO-Woche 'JJJJ-Wnn' (Montag-Sonntag) wie settlements.woche.
--
-- Rollback: drop table kassa_abschluss; Trigger und Spalten nr/pruefsumme entfernen;
--   Funktionen aus 2026-10-03-kassabuch.sql neu einspielen.
-- ============================================================================

alter table public.kassabuch
  add column if not exists nr integer,
  add column if not exists pruefsumme text;
create unique index if not exists kassabuch_nr on public.kassabuch (nr);

create table if not exists public.kassa_abschluss (
  woche             text primary key check (woche ~ '^\d{4}-W\d{2}$'),
  von               date not null,
  bis               date not null,
  anfangsbestand    numeric(10,2) not null,
  einnahmen         numeric(10,2) not null,
  ausgaben          numeric(10,2) not null,
  endbestand        numeric(10,2) not null,
  gezaehlt          numeric(10,2) not null,
  differenz         numeric(10,2) not null,
  buchungen         integer not null,
  letzte_nr         integer,
  letzte_pruefsumme text,
  abgeschlossen_von text not null,
  abgeschlossen_am  timestamptz not null default now()
);
alter table public.kassa_abschluss enable row level security;
revoke all on public.kassa_abschluss from anon;
drop policy if exists app_users_read on public.kassa_abschluss;
create policy app_users_read on public.kassa_abschluss for select to authenticated using (public.is_app_user());
grant select on public.kassa_abschluss to authenticated;

-- Pruefsumme einer Zeile: sha256 ueber die Summe davor und alle Felder der Zeile
create or replace function public.kassa_summe(p_davor text, r public.kassabuch) returns text
language sql stable set search_path = public as $$
  select encode(sha256(convert_to(concat_ws('|', coalesce(p_davor, ''), r.nr, to_char(r.datum, 'YYYY-MM-DD'), r.art, to_char(r.betrag, 'FM9999999990.00'), r.name,
    coalesce(r.text, ''), coalesce(r.storno_von::text, ''), r.angelegt_von,
    to_char(r.angelegt_am at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex')
$$;

-- Vor jedem Einfuegen: Nummer und Pruefsumme setzen. Die Sperre reiht gleichzeitige Buchungen.
create or replace function public.kassabuch_vor_einfuegen() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_nr integer; v_davor text;
begin
  lock table public.kassabuch in share row exclusive mode;
  select nr, pruefsumme into v_nr, v_davor from public.kassabuch order by nr desc limit 1;
  new.nr := coalesce(v_nr, 0) + 1;
  new.angelegt_am := now();
  new.pruefsumme := public.kassa_summe(v_davor, new);
  return new;
end $$;
drop trigger if exists kassabuch_vor_einfuegen on public.kassabuch;
create trigger kassabuch_vor_einfuegen before insert on public.kassabuch
  for each row execute function public.kassabuch_vor_einfuegen();

create or replace function public.kassa_gesperrt() returns trigger
language plpgsql as $$
begin
  raise exception 'Das Kassabuch wird nicht geändert oder gelöscht – Fehler bitte stornieren' using errcode = '42501';
end $$;
drop trigger if exists kassabuch_gesperrt on public.kassabuch;
create trigger kassabuch_gesperrt before update or delete on public.kassabuch
  for each row execute function public.kassa_gesperrt();
drop trigger if exists kassabuch_gesperrt_alles on public.kassabuch;
create trigger kassabuch_gesperrt_alles before truncate on public.kassabuch
  for each statement execute function public.kassa_gesperrt();
drop trigger if exists kassa_abschluss_gesperrt on public.kassa_abschluss;
create trigger kassa_abschluss_gesperrt before update or delete on public.kassa_abschluss
  for each row execute function public.kassa_gesperrt();
drop trigger if exists kassa_abschluss_gesperrt_alles on public.kassa_abschluss;
create trigger kassa_abschluss_gesperrt_alles before truncate on public.kassa_abschluss
  for each statement execute function public.kassa_gesperrt();

create or replace function public.kassa_wer() returns text
language sql stable set search_path = public as $$
  select nullif(btrim(coalesce(auth.jwt()->'app_metadata'->>'app_name', '')), '')
$$;

drop function if exists public.kassa_buchen(date, text, numeric, text, text);
create or replace function public.kassa_buchen(p_datum date, p_art text, p_betrag numeric, p_text text)
returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch; v_wer text := public.kassa_wer(); v_heute date := (now() at time zone 'Europe/Vienna')::date;
        v_anfang date; v_zu date;
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_art not in ('ein', 'aus') then raise exception 'Art muss ein oder aus sein' using errcode = '22023'; end if;
  if coalesce(round(p_betrag, 2), 0) <= 0 then raise exception 'Betrag fehlt' using errcode = '22023'; end if;
  if btrim(coalesce(p_text, '')) = '' then raise exception 'Text fehlt – wofür ist die Buchung?' using errcode = '22023'; end if;
  if p_datum is null or p_datum > v_heute then raise exception 'Datum fehlt oder liegt in der Zukunft' using errcode = '22023'; end if;
  select datum into v_anfang from public.kassabuch where art = 'anfang';
  if v_anfang is null then raise exception 'Zuerst den Anfangsbestand setzen' using errcode = '22023'; end if;
  if p_datum < v_anfang then
    raise exception 'Datum liegt vor dem Anfangsbestand (%)', to_char(v_anfang, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  select max(bis) into v_zu from public.kassa_abschluss;
  if v_zu is not null and p_datum <= v_zu then
    raise exception 'Die Woche bis % ist abgeschlossen', to_char(v_zu, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, angelegt_von)
  values (p_datum, p_art, round(p_betrag, 2), v_wer, btrim(p_text), v_wer)
  returning * into r;
  return r;
end $$;

-- Storno = Gegenbuchung am heutigen Tag durch den angemeldeten Benutzer; das Original bleibt stehen.
create or replace function public.kassa_storno(p_id bigint) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare o public.kassabuch; r public.kassabuch; v_wer text := public.kassa_wer();
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into o from public.kassabuch where id = p_id;
  if o.id is null then raise exception 'Buchung nicht gefunden' using errcode = 'P0002'; end if;
  if o.art = 'anfang' then raise exception 'Der Anfangsbestand wird nicht storniert' using errcode = '22023'; end if;
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

-- Anfangsbestand: genau einmal. Stimmt er nicht, wird er mit einer Buchung berichtigt.
create or replace function public.kassa_anfang(p_datum date, p_betrag numeric) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch; v_wer text := public.kassa_wer();
begin
  if not public.is_app_user() or v_wer is null then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_datum is null or p_betrag is null or p_betrag < 0 then raise exception 'Datum oder Betrag fehlt' using errcode = '22023'; end if;
  if p_datum > (now() at time zone 'Europe/Vienna')::date then raise exception 'Datum liegt in der Zukunft' using errcode = '22023'; end if;
  if exists (select 1 from public.kassabuch) then
    raise exception 'Der Anfangsbestand ist schon gesetzt – Abweichungen als Buchung eintragen' using errcode = '22023';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, angelegt_von)
  values (p_datum, 'anfang', round(p_betrag, 2), v_wer, 'Anfangsbestand', v_wer)
  returning * into r;
  return r;
end $$;

-- Woche abschliessen: Bestaende festhalten, Woche sperren. p_gezaehlt = was wirklich in der Kassa liegt.
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
    from public.kassabuch where datum < v_von or (art = 'anfang' and datum <= v_bis);
  select coalesce(sum(betrag) filter (where art = 'ein'), 0), coalesce(sum(betrag) filter (where art = 'aus'), 0),
         count(*) filter (where art <> 'anfang')
    into v_ein, v_aus, v_n from public.kassabuch where datum between v_von and v_bis;
  select nr, pruefsumme into v_nr, v_ps from public.kassabuch order by nr desc limit 1;
  insert into public.kassa_abschluss (woche, von, bis, anfangsbestand, einnahmen, ausgaben, endbestand, gezaehlt, differenz,
                                      buchungen, letzte_nr, letzte_pruefsumme, abgeschlossen_von)
  values (p_woche, v_von, v_bis, v_anfang, v_ein, v_aus, v_anfang + v_ein - v_aus, round(p_gezaehlt, 2),
          round(p_gezaehlt, 2) - (v_anfang + v_ein - v_aus), v_n, v_nr, v_ps, v_wer)
  returning * into r;
  return r;
end $$;

-- Kette und Abschluesse nachrechnen. fehler_nr = erste Buchung, ab der etwas nicht stimmt.
create or replace function public.kassa_pruefen() returns table (ok boolean, buchungen integer, fehler_nr integer, hinweis text)
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch; a public.kassa_abschluss; v_davor text := null; v_soll integer := 0; v_n integer := 0;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  for r in select * from public.kassabuch order by nr nulls first, id loop
    v_soll := v_soll + 1; v_n := v_n + 1;
    if r.nr is distinct from v_soll then
      return query select false, v_n, v_soll, 'Nummer ' || v_soll || ' fehlt – eine Buchung wurde entfernt'; return;
    end if;
    if r.pruefsumme is distinct from public.kassa_summe(v_davor, r) then
      return query select false, v_n, r.nr, 'Buchung Nr. ' || r.nr || ' wurde nachträglich verändert'; return;
    end if;
    v_davor := r.pruefsumme;
  end loop;
  for a in select * from public.kassa_abschluss order by von loop
    if a.letzte_nr is not null and not exists (select 1 from public.kassabuch k where k.nr = a.letzte_nr and k.pruefsumme = a.letzte_pruefsumme) then
      return query select false, v_n, a.letzte_nr, 'Abschluss KW ' || a.woche || ' passt nicht mehr zu den Buchungen'; return;
    end if;
    if a.endbestand is distinct from (select coalesce(sum(case when art = 'aus' then -betrag else betrag end), 0) from public.kassabuch where datum <= a.bis) then
      return query select false, v_n, a.letzte_nr, 'Endbestand KW ' || a.woche || ' stimmt nicht mehr mit den Buchungen überein'; return;
    end if;
  end loop;
  return query select true, v_n, null::integer, null::text;
end $$;

revoke all on function public.kassa_buchen(date, text, numeric, text), public.kassa_storno(bigint), public.kassa_anfang(date, numeric),
  public.kassa_abschliessen(text, numeric), public.kassa_pruefen(), public.kassa_summe(text, public.kassabuch),
  public.kassabuch_vor_einfuegen(), public.kassa_gesperrt(), public.kassa_wer() from public, anon;
revoke all on function public.kassa_summe(text, public.kassabuch), public.kassabuch_vor_einfuegen(), public.kassa_gesperrt(),
  public.kassa_wer() from authenticated;
grant execute on function public.kassa_buchen(date, text, numeric, text), public.kassa_storno(bigint), public.kassa_anfang(date, numeric),
  public.kassa_abschliessen(text, numeric), public.kassa_pruefen() to authenticated;
