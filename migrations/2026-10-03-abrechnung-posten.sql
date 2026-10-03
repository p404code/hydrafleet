-- ============================================================================
-- Zu-/Abschlaege in der Wochenabrechnung (z. B. "Pickerl selbst bezahlt +70")
-- Datum: 2026-10-03
--
-- settlements.korrektur / korrektur_note gibt es seit 2026-04-20; Druck,
-- WhatsApp, CSV, Fahrerapp und Kassieren zeigen bzw. rechnen sie schon.
-- Neu ist nur die Eingabe: mehrere Posten je Fahrer und Woche, deren Summe
-- in korrektur und auszahlung landet. Der AbrechnungsBot bleibt unberuehrt.
--
-- Schreibt der Bot (oder die Alias-Zuordnung im Dashboard) die Zeile neu,
-- faellt die Korrektur aus der Auszahlung. abrechnung_posten_stand merkt sich
-- deshalb die Auszahlung nach dem Anwenden; weicht sie ab, zeigt
-- abrechnung_posten_offen die Zeile und posten_neu_anwenden() rechnet wieder ein.
--
-- Rollback: drop view abrechnung_posten_offen; drop function posten_anlegen,
--   posten_loeschen, posten_neu_anwenden, posten_anwenden;
--   drop table abrechnung_posten_stand, abrechnung_posten;
--   (settlements bleibt, wie es zuletzt angewendet wurde)
-- ============================================================================

create table if not exists public.abrechnung_posten (
  id            bigint generated always as identity primary key,
  woche         text not null,
  fahrer_name   text not null,
  betrag        numeric(10,2) not null check (betrag <> 0),
  text          text not null check (btrim(text) <> ''),
  angelegt_von  text not null,
  angelegt_am   timestamptz not null default now()
);
create index if not exists abrechnung_posten_woche_fahrer on public.abrechnung_posten (woche, fahrer_name);

create table if not exists public.abrechnung_posten_stand (
  woche            text not null,
  fahrer_name      text not null,
  summe            numeric(10,2) not null,
  auszahlung_nach  numeric not null,
  angewendet_am    timestamptz not null default now(),
  primary key (woche, fahrer_name)
);

alter table public.abrechnung_posten enable row level security;
alter table public.abrechnung_posten_stand enable row level security;
revoke all on public.abrechnung_posten, public.abrechnung_posten_stand from anon;
-- Nur lesen; geschrieben wird ausschliesslich ueber die RPCs unten.
drop policy if exists app_users_read on public.abrechnung_posten;
drop policy if exists app_users_read on public.abrechnung_posten_stand;
create policy app_users_read on public.abrechnung_posten for select to authenticated using (public.is_app_user());
create policy app_users_read on public.abrechnung_posten_stand for select to authenticated using (public.is_app_user());

-- Summe der Posten in settlements einrechnen. Intern, nicht von aussen aufrufbar.
create or replace function public.posten_anwenden(p_woche text, p_fahrer_name text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s        public.settlements;
  st       public.abrechnung_posten_stand;
  v_summe  numeric(10,2);
  v_n      integer;
  v_note   text;
  v_basis  numeric;
  v_neu    numeric;
begin
  select * into s from public.settlements where woche = p_woche and fahrer_name = p_fahrer_name for update;
  if not found then return; end if;
  select * into st from public.abrechnung_posten_stand where woche = p_woche and fahrer_name = p_fahrer_name;

  -- Basis = Auszahlung ohne Korrektur. Steht die Auszahlung nicht mehr so da,
  -- wie wir sie zuletzt geschrieben haben, hat jemand die Zeile neu gerechnet:
  -- dann IST sie die Basis.
  if st.woche is not null and s.auszahlung is distinct from st.auszahlung_nach then
    v_basis := coalesce(s.auszahlung, 0);
  else
    v_basis := coalesce(s.auszahlung, 0) - coalesce(s.korrektur, 0);
  end if;

  select coalesce(sum(betrag), 0), count(*) into v_summe, v_n
  from public.abrechnung_posten where woche = p_woche and fahrer_name = p_fahrer_name;
  select case when v_n = 0 then null
              when v_n = 1 then max(text)
              else string_agg(text || ' ' || case when betrag > 0 then '+' else '−' end
                     || replace(to_char(abs(betrag), 'FM999990.00'), '.', ','), '; ' order by id) end
    into v_note
  from public.abrechnung_posten where woche = p_woche and fahrer_name = p_fahrer_name;

  v_neu := round(v_basis + v_summe, 2);
  update public.settlements set auszahlung = v_neu, korrektur = v_summe, korrektur_note = v_note where id = s.id;

  if v_n = 0 then
    delete from public.abrechnung_posten_stand where woche = p_woche and fahrer_name = p_fahrer_name;
  else
    insert into public.abrechnung_posten_stand (woche, fahrer_name, summe, auszahlung_nach)
    values (p_woche, p_fahrer_name, v_summe, v_neu)
    on conflict (woche, fahrer_name) do update
      set summe = excluded.summe, auszahlung_nach = excluded.auszahlung_nach, angewendet_am = now();
  end if;
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
  return r;
end $$;

create or replace function public.posten_loeschen(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_posten;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  delete from public.abrechnung_posten where id = p_id returning * into r;
  if r.id is null then raise exception 'Posten nicht gefunden' using errcode = 'P0002'; end if;
  perform public.posten_anwenden(r.woche, r.fahrer_name);
end $$;

-- Posten, die nach einem neuen Upload nicht mehr in der Auszahlung stecken.
create or replace view public.abrechnung_posten_offen with (security_invoker = true) as
select st.woche, st.fahrer_name, st.summe
from public.abrechnung_posten_stand st
join public.settlements s on s.woche = st.woche and s.fahrer_name = st.fahrer_name
where s.auszahlung is distinct from st.auszahlung_nach
   or coalesce(s.korrektur, 0) <> st.summe;

create or replace function public.posten_neu_anwenden(p_woche text) returns integer
language plpgsql security definer set search_path = public as $$
declare v record; n integer := 0;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  for v in select fahrer_name from public.abrechnung_posten_offen where woche = p_woche loop
    perform public.posten_anwenden(p_woche, v.fahrer_name);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.posten_anwenden(text, text), public.posten_anlegen(text, text, numeric, text),
  public.posten_loeschen(bigint), public.posten_neu_anwenden(text) from public, anon, authenticated;
grant execute on function public.posten_anlegen(text, text, numeric, text),
  public.posten_loeschen(bigint), public.posten_neu_anwenden(text) to authenticated;
grant select on public.abrechnung_posten, public.abrechnung_posten_stand, public.abrechnung_posten_offen to authenticated;

-- Bestehende Korrekturen (KW17, April) als Posten uebernehmen, damit ein
-- spaeterer Posten sie nicht ueberschreibt. settlements wird dabei nicht geaendert.
insert into public.abrechnung_posten (woche, fahrer_name, betrag, text, angelegt_von)
select s.woche, s.fahrer_name, s.korrektur, coalesce(nullif(btrim(s.korrektur_note), ''), 'Korrektur'), 'Übernahme'
from public.settlements s
where coalesce(s.korrektur, 0) <> 0
  and not exists (select 1 from public.abrechnung_posten p where p.woche = s.woche and p.fahrer_name = s.fahrer_name);
insert into public.abrechnung_posten_stand (woche, fahrer_name, summe, auszahlung_nach)
select s.woche, s.fahrer_name, s.korrektur, s.auszahlung
from public.settlements s
where coalesce(s.korrektur, 0) <> 0
on conflict (woche, fahrer_name) do nothing;
