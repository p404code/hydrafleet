-- Fahrer sehen nie, wer im Buero geantwortet hat (Betreiber 26.10.2026): fahrer_app_nachrichten liefert fuer Team-Nachrichten
-- immer "Büro". team_name bleibt in der Tabelle (intern: wer hat geantwortet), wird aber nicht mehr an die App gegeben.
create or replace function public.fahrer_app_nachrichten(p_fahrer_id integer default null)
returns table (id bigint, richtung text, text text, team_name text, erstellt_am timestamptz, gelesen_am timestamptz,
               zugestellt boolean, an_alle boolean)
language sql stable security definer set search_path = public as $$
  select x.id, x.richtung, x.text, case when x.richtung = 'team' then 'Büro' end, x.erstellt_am, x.gelesen_am,
         (x.richtung = 'team' or x.tg_message_id is not null), x.an_alle
  from (select n.* from public.nachrichten n
        where n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
        order by n.erstellt_am desc, n.id desc limit 50) x
  order by x.erstellt_am, x.id
$$;
