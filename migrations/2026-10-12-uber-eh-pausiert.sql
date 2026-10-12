-- EH Limousinenservice KG faehrt nicht mehr ueber Uber (Fahrer seit 25.09.2026
-- bei E&E Taxi KG, Sitzung abgelaufen). Die Verbindung bleibt als Zeile stehen
-- (alte Wochen in uber_reports haengen an ihrer org_id), wird aber nicht mehr
-- abgerufen: uber-sync nimmt nur status = 'aktiv'.
update public.verbindungen
   set status = 'pausiert', letzter_fehler = null
 where anbieter = 'uber' and firma = 'eh_limousinenservice_kg';

-- Pausierte Verbindungen gehoeren nicht in den Verbindungen-Reiter: sonst steht
-- dort dauerhaft der letzte Fehler und "n / m ok" stimmt nie.
do $do$
declare def text := pg_get_viewdef('public.verbindungen_status'::regclass, true);
begin
  if def not like '%pausiert%' then
    execute 'create or replace view public.verbindungen_status with (security_invoker = true) as '
      || rtrim(rtrim(def), ';') || ' where v.status <> ''pausiert''';
  end if;
end
$do$;
