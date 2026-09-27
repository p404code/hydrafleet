-- Fahrerapp-Reiter "Fahrzeug": fahrer_app_profil() liefert zusaetzlich die
-- Fahrgestellnummer (fuhrpark.vin, Quelle Notion). Der Rueckgabetyp aendert
-- sich, deshalb drop + create; Rechte wie vorher (authenticated, service_role).

drop function if exists public.fahrer_app_profil(integer);

create function public.fahrer_app_profil(p_fahrer_id integer default null)
 returns table(fahrer_id integer, fahrer_nr integer, name text, kennzeichen text, mietmodell text,
               fahrzeug_modell text, vorschau boolean, nr_eindeutig boolean, app_zugang text,
               fahrzeug_vin text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select f.id, f.notion_fahrer_id, f.name, f.kennzeichen, f.mietmodell,
         fp.modell,
         (p_fahrer_id is not null and public.is_app_user()),
         (f.notion_fahrer_id is not null
          and (select count(*) from public.fahrer x where x.aktiv and x.notion_fahrer_id = f.notion_fahrer_id) = 1),
         case when z.notion_fahrer_id is null then 'kein_zugang'
              when z.gesperrt then 'gesperrt' else 'aktiv' end,
         nullif(trim(fp.vin), '')
  from public.fahrer f
  left join public.fuhrpark fp
    on fp.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen,'') <> ''
  left join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id)
$function$;

revoke all on function public.fahrer_app_profil(integer) from public, anon;
grant execute on function public.fahrer_app_profil(integer) to authenticated, service_role;
