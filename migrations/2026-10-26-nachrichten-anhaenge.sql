-- Fahrer-Nachrichten Teil 3: Fotos und Sprachnachrichten. Dateien bleiben in Telegram, hier steht nur die file_id.
-- Spec: docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md, Teil 3.

alter table public.nachrichten add column if not exists anhang text;
alter table public.nachrichten add column if not exists tg_file_id text;
alter table public.nachrichten add column if not exists dauer integer;

-- Text: ohne Anhang 1–2000 Zeichen, mit Anhang 0–2000 (Bildunterschrift optional); Anhang immer mit Telegram-Datei
alter table public.nachrichten drop constraint if exists nachrichten_text_check;
alter table public.nachrichten drop constraint if exists nachrichten_text_regel;
alter table public.nachrichten add constraint nachrichten_text_regel check (
  char_length(text) <= 2000 and (anhang is not null or char_length(btrim(text)) >= 1));
alter table public.nachrichten drop constraint if exists nachrichten_anhang_check;
alter table public.nachrichten add constraint nachrichten_anhang_check check (
  (anhang is null or anhang in ('foto', 'sprache')) and (anhang is null or tg_file_id is not null)
  and (dauer is null or dauer between 0 and 3600));

-- App: zusaetzlich anhang und dauer (die file_id bekommt die App nie; Team-Name weiter nur "Büro")
drop function if exists public.fahrer_app_nachrichten(integer);
create function public.fahrer_app_nachrichten(p_fahrer_id integer default null)
returns table (id bigint, richtung text, text text, team_name text, erstellt_am timestamptz, gelesen_am timestamptz,
               zugestellt boolean, an_alle boolean, anhang text, dauer integer)
language sql stable security definer set search_path = public as $$
  select x.id, x.richtung, x.text, case when x.richtung = 'team' then 'Büro' end, x.erstellt_am, x.gelesen_am,
         (x.richtung = 'team' or x.tg_message_id is not null), x.an_alle, x.anhang, x.dauer
  from (select n.* from public.nachrichten n
        where n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
        order by n.erstellt_am desc, n.id desc limit 50) x
  order by x.erstellt_am, x.id
$$;

-- Datei zu einer Nachricht – nur fuer den Fahrer selbst bzw. das Buero in der Vorschau (Edge Function anhang ruft das
-- mit dem JWT des Aufrufers auf)
create or replace function public.fahrer_app_anhang(p_id bigint, p_fahrer_id integer default null)
returns table (tg_file_id text, anhang text)
language sql stable security definer set search_path = public as $$
  select n.tg_file_id, n.anhang from public.nachrichten n
  where n.id = p_id and n.anhang is not null and n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
$$;

revoke all on function public.fahrer_app_nachrichten(integer), public.fahrer_app_anhang(bigint, integer) from public, anon;
grant execute on function public.fahrer_app_nachrichten(integer), public.fahrer_app_anhang(bigint, integer) to authenticated;
