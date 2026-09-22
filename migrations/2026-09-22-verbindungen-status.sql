-- Statusseite fuer die Verbindungen. Am 2026-09-22 eingespielt
-- (verbindungen_status_view, verbindungen_status_umlaute).
--
-- gueltig_bis steht bewusst NEBEN dem Vault, nicht darin: das Ablaufdatum ist
-- kein Geheimnis, und eine View darf niemals entschluesseln. So kann das
-- Dashboard warnen, ohne je an die Zugangsdaten zu kommen.
--
-- Bei Bolt bleibt gueltig_bis leer: das Token wird bei jedem Lauf frisch geholt,
-- es laeuft also nichts ab. Bei Uber steht dort das Ende des kuerzesten
-- Anmelde-Cookies, das der Sync mitschickt.
alter table public.verbindungen
  add column if not exists gueltig_bis timestamptz;

comment on column public.verbindungen.gueltig_bis is
  'Wann der hinterlegte Zugang ablaeuft. Bei Bolt leer (Token wird je Lauf neu geholt), '
  'bei Uber das Ende der kuerzesten Anmelde-Cookies.';

-- Wie oft der jeweilige Anbieter laufen sollte - braucht es, um "veraltet" von
-- "laeuft normal" zu unterscheiden. Mit Luft nach oben, damit ein einzelner
-- verpasster Takt noch keinen Alarm ausloest.
create or replace function public.sync_takt(p_anbieter text) returns interval
language sql immutable as $$
  select case p_anbieter
           when 'notion' then interval '45 minutes'   -- laeuft alle 10 Minuten
           else               interval '8 days'        -- laeuft woechentlich
         end;
$$;

create or replace view public.verbindungen_status with (security_invoker = true) as
with letzter as (
  select distinct on (verbindung_id) verbindung_id, start, ende, status, anzahl, fehler,
         round(extract(epoch from (ende - start))::numeric, 1) as dauer_sek
  from public.sync_runs order by verbindung_id, start desc
),
sieben as (
  select verbindung_id,
         count(*)::int                                  as laeufe_7t,
         count(*) filter (where status = 'fehler')::int  as fehler_7t
  from public.sync_runs where start > now() - interval '7 days'
  group by 1
),
daten as (
  select 'bolt' as anbieter, max(woche) as bis, count(*)::int as zeilen from public.bolt_orders
  union all
  select 'uber', max(woche), count(*)::int from public.uber_reports
  union all
  select 'notion', null, (select count(*)::int from public.fuhrpark)
)
select
  v.id, v.anbieter, coalesce(v.firma, '-') as firma, v.externe_id,
  v.status, v.letzter_abruf, v.letzter_fehler, v.gueltig_bis,
  case when v.gueltig_bis is null then null
       else greatest(0, extract(day from (v.gueltig_bis - now()))::int) end as tage_bis_ablauf,
  l.start     as letzter_lauf,
  l.status    as letzter_lauf_status,
  l.anzahl    as letzter_lauf_anzahl,
  l.dauer_sek as letzter_lauf_dauer,
  coalesce(s.laeufe_7t, 0) as laeufe_7t,
  coalesce(s.fehler_7t, 0) as fehler_7t,
  d.bis    as daten_bis,
  d.zeilen as daten_zeilen,
  -- Ein Befund statt vieler Einzelwerte. Reihenfolge = Dringlichkeit.
  -- Der Text wird im Dashboard unveraendert angezeigt, daher mit Umlauten.
  case
    when v.status = 'fehler' or l.status = 'fehler'                 then 'Fehler'
    when v.gueltig_bis is not null and v.gueltig_bis < now()        then 'Zugang abgelaufen'
    when v.gueltig_bis is not null
         and v.gueltig_bis < now() + interval '7 days'              then 'Zugang läuft bald ab'
    when v.letzter_abruf is null                                    then 'nie gelaufen'
    when v.letzter_abruf < now() - public.sync_takt(v.anbieter)     then 'veraltet'
    else 'ok'
  end as befund
from public.verbindungen v
left join letzter l on l.verbindung_id = v.id
left join sieben  s on s.verbindung_id = v.id
left join daten   d on d.anbieter = v.anbieter;

grant select on public.verbindungen_status to authenticated;

-- Uber: massgeblich ist das kuerzeste Anmelde-Cookie, das der Sync mitschickt.
-- sp-jwt-session laeuft am 6.10.2026 ab; sid und csid halten laenger, nuetzen
-- ohne sp-jwt-session aber nichts, weil das Nachspielen kein neues holt.
update public.verbindungen set gueltig_bis = '2026-10-06 17:21:00+00' where anbieter = 'uber';
