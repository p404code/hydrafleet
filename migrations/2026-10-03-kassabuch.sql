-- ============================================================================
-- Kassabuch: eine Bargeldkassa, wer gibt hinein / nimmt heraus
-- Datum: 2026-10-03
--
-- Jede Zeile ist eine Buchung. art: 'anfang' (Anfangsbestand, hoechstens eine),
-- 'ein' (hinein), 'aus' (heraus). Bestand = anfang + ein - aus, gerechnet im
-- Dashboard. Nichts wird geaendert oder geloescht: ein Fehler wird storniert
-- (Gegenbuchung mit storno_von). Geschrieben wird nur ueber die RPCs.
-- Haengt bewusst nicht an Kassieren (kassier_zahlungen) oder settlements.
--
-- Rollback: drop function kassa_buchen, kassa_storno, kassa_anfang; drop table kassabuch;
-- ============================================================================

create table if not exists public.kassabuch (
  id            bigint generated always as identity primary key,
  datum         date not null,
  art           text not null check (art in ('anfang', 'ein', 'aus')),
  betrag        numeric(10,2) not null check (betrag >= 0),
  name          text not null check (btrim(name) <> ''),
  text          text,
  storno_von    bigint references public.kassabuch(id),
  angelegt_von  text not null,
  angelegt_am   timestamptz not null default now(),
  check (art = 'anfang' or betrag > 0)
);
create unique index if not exists kassabuch_ein_anfang on public.kassabuch ((true)) where art = 'anfang';
create unique index if not exists kassabuch_storno_einmal on public.kassabuch (storno_von) where storno_von is not null;
create index if not exists kassabuch_datum on public.kassabuch (datum, id);

alter table public.kassabuch enable row level security;
revoke all on public.kassabuch from anon;
drop policy if exists app_users_read on public.kassabuch;
create policy app_users_read on public.kassabuch for select to authenticated using (public.is_app_user());
grant select on public.kassabuch to authenticated;

create or replace function public.kassa_buchen(p_datum date, p_art text, p_betrag numeric, p_name text, p_text text)
returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch; v_heute date := (now() at time zone 'Europe/Vienna')::date; v_anfang date;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_art not in ('ein', 'aus') then raise exception 'Art muss ein oder aus sein' using errcode = '22023'; end if;
  if coalesce(round(p_betrag, 2), 0) <= 0 then raise exception 'Betrag fehlt' using errcode = '22023'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Name fehlt' using errcode = '22023'; end if;
  if p_datum is null or p_datum > v_heute then raise exception 'Datum fehlt oder liegt in der Zukunft' using errcode = '22023'; end if;
  select datum into v_anfang from public.kassabuch where art = 'anfang';
  if v_anfang is not null and p_datum < v_anfang then
    raise exception 'Datum liegt vor dem Anfangsbestand (%)', to_char(v_anfang, 'DD.MM.YYYY') using errcode = '22023';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, angelegt_von)
  values (p_datum, p_art, round(p_betrag, 2), btrim(p_name), nullif(btrim(coalesce(p_text, '')), ''),
          coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  returning * into r;
  return r;
end $$;

-- Storno = Gegenbuchung am heutigen Tag; die urspruengliche Zeile bleibt stehen.
create or replace function public.kassa_storno(p_id bigint) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare o public.kassabuch; r public.kassabuch;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into o from public.kassabuch where id = p_id for update;
  if o.id is null then raise exception 'Buchung nicht gefunden' using errcode = 'P0002'; end if;
  if o.art = 'anfang' then raise exception 'Der Anfangsbestand wird nicht storniert' using errcode = '22023'; end if;
  if o.storno_von is not null then raise exception 'Ein Storno wird nicht storniert' using errcode = '22023'; end if;
  if exists (select 1 from public.kassabuch where storno_von = p_id) then
    raise exception 'Schon storniert' using errcode = '23505';
  end if;
  insert into public.kassabuch (datum, art, betrag, name, text, storno_von, angelegt_von)
  values ((now() at time zone 'Europe/Vienna')::date, case o.art when 'ein' then 'aus' else 'ein' end, o.betrag, o.name,
          'Storno ' || to_char(o.datum, 'DD.MM.') || coalesce(': ' || o.text, ''), o.id,
          coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  returning * into r;
  return r;
end $$;

-- Anfangsbestand: einmal setzen; aendern nur, solange noch nichts gebucht ist.
create or replace function public.kassa_anfang(p_datum date, p_betrag numeric) returns public.kassabuch
language plpgsql security definer set search_path = public as $$
declare r public.kassabuch;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_datum is null or p_betrag is null or p_betrag < 0 then raise exception 'Datum oder Betrag fehlt' using errcode = '22023'; end if;
  if exists (select 1 from public.kassabuch where art <> 'anfang') then
    if exists (select 1 from public.kassabuch where art = 'anfang') then
      raise exception 'Es gibt schon Buchungen – der Anfangsbestand ist fest' using errcode = '22023';
    end if;
    if exists (select 1 from public.kassabuch where datum < p_datum) then
      raise exception 'Es gibt Buchungen vor diesem Datum' using errcode = '22023';
    end if;
  end if;
  delete from public.kassabuch where art = 'anfang';
  insert into public.kassabuch (datum, art, betrag, name, text, angelegt_von)
  values (p_datum, 'anfang', round(p_betrag, 2), 'Anfangsbestand', null,
          coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  returning * into r;
  return r;
end $$;

revoke all on function public.kassa_buchen(date, text, numeric, text, text), public.kassa_storno(bigint),
  public.kassa_anfang(date, numeric) from public, anon;
grant execute on function public.kassa_buchen(date, text, numeric, text, text), public.kassa_storno(bigint),
  public.kassa_anfang(date, numeric) to authenticated;
