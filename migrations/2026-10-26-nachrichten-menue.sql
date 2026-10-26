-- Fahrer-Nachrichten Teil 2: Menue in "Allgemein" (an alle, Fahrer finden), Themen fuer alle Fahrer, Gelesen-Anzeige.
-- Spec: docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md, Teil 2. Baut auf 2026-10-22-fahrer-nachrichten.sql auf.

-- Nachricht an alle: eine Zeile je Fahrer mit derselben Telegram-Id -> Eindeutigkeit je Fahrer
alter table public.nachrichten add column if not exists an_alle boolean not null default false;
drop index if exists public.nachrichten_team_tg_einmal;
create unique index if not exists nachrichten_team_tg_fahrer_einmal on public.nachrichten (tg_message_id, fahrer_nr) where richtung = 'team';

-- Offene Menue-Schritte: Aufforderung des Bots (prompt_message_id) -> wer hat geklickt, was wird gerade gemacht
create table if not exists public.tg_menue (
  prompt_message_id   bigint primary key,
  art                 text not null check (art in ('alle', 'suche')),
  tg_user_id          bigint not null,
  tg_name             text,
  entwurf             text,
  vorschau_message_id bigint,
  erstellt_am         timestamptz not null default now()
);
alter table public.tg_menue enable row level security;
revoke all on public.tg_menue from public, anon, authenticated;
grant all on public.tg_menue to service_role;

-- Berechtigte Fahrer (aktiv, App-Zugang nicht gesperrt, Notion-Nr. eindeutig) mit Kopf aus dem Fuhrpark
create or replace function public.tg_fahrer_liste()
returns table (fahrer_nr integer, name text, kennzeichen text, modell text)
language sql stable security definer set search_path = public as $$
  select f.notion_fahrer_id, f.name, nullif(btrim(coalesce(f.kennzeichen, '')), ''), nullif(btrim(coalesce(fp.modell, '')), '')
  from public.fahrer f
  join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id and not z.gesperrt
  left join public.fuhrpark fp on fp.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen, '') <> ''
  where f.aktiv
    and (select count(*) from public.fahrer x where x.aktiv and x.notion_fahrer_id = f.notion_fahrer_id) = 1
  order by f.name
$$;

-- Suche fuer "Fahrer finden": Name (Teil), Fahrer-Nr. (genau), Kennzeichen (ohne Striche); hoechstens 8
create or replace function public.tg_fahrer_suchen(p_q text)
returns table (fahrer_nr integer, name text, kennzeichen text, thread_id bigint)
language sql stable security definer set search_path = public as $$
  with q as (select btrim(coalesce(p_q, '')) as t)
  select l.fahrer_nr, l.name, l.kennzeichen, th.thread_id
  from public.tg_fahrer_liste() l
  cross join q
  left join public.tg_themen th on th.fahrer_nr = l.fahrer_nr
  where q.t <> ''
    and (l.name ilike '%' || q.t || '%'
         or l.fahrer_nr::text = q.t
         or (public.kennzeichen_key(q.t) <> '' and public.kennzeichen_key(l.kennzeichen) like '%' || public.kennzeichen_key(q.t) || '%'))
  order by l.name
  limit 8
$$;

-- Nachricht an alle: je berechtigtem Fahrer eine Team-Zeile (Trigger -> Push). Doppelter Aufruf legt nichts doppelt an.
create or replace function public.tg_an_alle(p_text text, p_team_name text, p_tg_message_id bigint) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if btrim(coalesce(p_text, '')) = '' then raise exception 'Nachricht ist leer'; end if;
  insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id, an_alle)
  select l.fahrer_nr, 'team', left(btrim(p_text), 2000), p_team_name, p_tg_message_id, true
  from public.tg_fahrer_liste() l
  on conflict (tg_message_id, fahrer_nr) where richtung = 'team' do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- App: zusaetzlich zugestellt (eigene Nachricht steht in der Gruppe) und an_alle
drop function if exists public.fahrer_app_nachrichten(integer);
create function public.fahrer_app_nachrichten(p_fahrer_id integer default null)
returns table (id bigint, richtung text, text text, team_name text, erstellt_am timestamptz, gelesen_am timestamptz,
               zugestellt boolean, an_alle boolean)
language sql stable security definer set search_path = public as $$
  select x.id, x.richtung, x.text, x.team_name, x.erstellt_am, x.gelesen_am,
         (x.richtung = 'team' or x.tg_message_id is not null), x.an_alle
  from (select n.* from public.nachrichten n
        where n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
        order by n.erstellt_am desc, n.id desc limit 50) x
  order by x.erstellt_am, x.id
$$;

-- Gelesen: Fahrer hat eine Team-Antwort gesehen -> Bot setzt 👀 auf die Telegram-Nachricht (nicht bei "an alle")
create or replace function public.nachrichten_gelesen_melden() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-senden',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := jsonb_build_object('gelesen', new.id),
      timeout_milliseconds := 30000);
  exception when others then
    raise warning 'nachrichten_gelesen_melden(%): %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists nachrichten_gelesen_melden on public.nachrichten;
create trigger nachrichten_gelesen_melden after update of gelesen_am on public.nachrichten
  for each row when (old.gelesen_am is null and new.gelesen_am is not null and new.richtung = 'team'
                     and not new.an_alle and new.tg_message_id is not null)
  execute function public.nachrichten_gelesen_melden();

revoke all on function public.tg_fahrer_liste(), public.tg_fahrer_suchen(text), public.tg_an_alle(text, text, bigint),
  public.nachrichten_gelesen_melden() from public, anon, authenticated;
grant execute on function public.tg_fahrer_liste(), public.tg_fahrer_suchen(text), public.tg_an_alle(text, text, bigint) to service_role;
revoke all on function public.fahrer_app_nachrichten(integer) from public, anon;
grant execute on function public.fahrer_app_nachrichten(integer) to authenticated;

-- Themen-Lauf: legt fehlende Themen an (in Etappen, Telegram bremst), ruft nur wenn noetig
do $$
begin
  if exists (select 1 from cron.job where jobname = 'themen-pflegen') then
    perform cron.unschedule('themen-pflegen');
  end if;
  perform cron.schedule('themen-pflegen', '*/5 * * * *', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-senden',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"themen": true}'::jsonb, timeout_milliseconds := 120000)
    where exists (select 1 from public.tg_fahrer_liste() l
                  left join public.tg_themen t on t.fahrer_nr = l.fahrer_nr
                  where t.thread_id is null
                     or coalesce(t.kennzeichen, '') <> coalesce(l.kennzeichen, ''));
  $job$);
end $$;
