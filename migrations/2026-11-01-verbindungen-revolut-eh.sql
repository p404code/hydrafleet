-- ============================================================================
-- Verbindungen-Reiter: Revolut anzeigen, EH-Bolt herausnehmen (Betreiber 01.11.2026)
--
-- * EH-Bolt (eh_limousinenservice_kg) -> pausiert: kein Abruf mehr, aus verbindungen_status ausgeblendet.
--   Zugang bleibt im Vault (wieder aktivieren: status = 'aktiv'). Seit 14.10. keine Aufträge.
-- * Revolut hat keine Zeile in verbindungen (Secrets als Edge-Function-Secrets). Stand kommt aus revolut_abruf
--   (täglicher Abruf 05:45 + Knopf „Revolut abrufen“) -> eigene Zeile in verbindungen_status.
-- * sync_takt('revolut') = 2 Tage (täglich, mit Luft).
--
-- Rollback: update verbindungen set status = 'aktiv' where anbieter = 'bolt' and firma = 'eh_limousinenservice_kg';
--   verbindungen_status / sync_takt aus 2026-09-22-*.sql neu anlegen
-- ============================================================================

update public.verbindungen set status = 'pausiert'
 where anbieter = 'bolt' and firma = 'eh_limousinenservice_kg' and status = 'aktiv';

create or replace function public.sync_takt(p_anbieter text)
returns interval language sql immutable as $$
  select case p_anbieter
           when 'notion'  then interval '45 minutes'   -- alle 10 Min, mit Luft
           when 'revolut' then interval '2 days'       -- täglich 05:45, mit Luft
           else                interval '8 days'       -- woechentlich, mit Luft
         end;
$$;

-- Revolut-Zeile an die bestehende Ansicht anhängen (live-Text übernehmen, damit nichts anderes abweicht)
do $$
declare
  d text := pg_get_viewdef('public.verbindungen_status'::regclass, true);
begin
  if position('''revolut''' in d) > 0 then return; end if;
  d := rtrim(rtrim(d), ';');
  execute 'create or replace view public.verbindungen_status with (security_invoker = true) as ' || d || $u$
UNION ALL
 SELECT md5('revolut-serdo')::uuid AS id,
    'revolut'::text AS anbieter,
    'serdo'::text AS firma,
    NULL::text AS externe_id,
    'aktiv'::text AS status,
    ra.letzter_lauf AS letzter_abruf,
    ra.letzter_fehler,
    NULL::timestamp with time zone AS gueltig_bis,
    NULL::integer AS tage_bis_ablauf,
    ra.letzter_lauf,
    CASE WHEN ra.letzter_lauf IS NULL THEN NULL::text WHEN ra.letzter_fehler IS NOT NULL THEN 'fehler'::text ELSE 'ok'::text END AS letzter_lauf_status,
    ra.anzahl AS letzter_lauf_anzahl,
    NULL::numeric AS letzter_lauf_dauer,
    NULL::integer AS laeufe_7t,
    NULL::integer AS fehler_7t,
    to_char((SELECT max(b.erstellt_am) FROM public.revolut_buchungen b) AT TIME ZONE 'Europe/Vienna', 'DD.MM.YYYY') AS daten_bis,
    (SELECT count(*)::integer FROM public.revolut_buchungen) AS daten_zeilen,
        CASE
            WHEN ra.letzter_fehler IS NOT NULL THEN 'Fehler'::text
            WHEN ra.letzter_lauf IS NULL THEN 'nie gelaufen'::text
            WHEN ra.letzter_lauf < (now() - sync_takt('revolut'::text)) THEN 'veraltet'::text
            ELSE 'ok'::text
        END AS befund
   FROM public.revolut_abruf ra$u$;
end $$;
