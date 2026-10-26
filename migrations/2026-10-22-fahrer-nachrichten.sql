-- Fahrer-Nachrichten ueber Telegram: Fahrer schreibt in der App, das Buero antwortet in seinem Telegram-Thema.
-- Spec: docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md
-- Schluessel ist die Notion-Fahrer-Nr. (fahrer.id ist nicht stabil, der n8n-Sync legt Zeilen neu an).
-- Kein Protokoll-Trigger: das Buero schreibt hier nicht (nur Fahrer-RPCs und service_role).

create table if not exists public.nachrichten (
  id            bigint generated always as identity primary key,
  fahrer_nr     integer not null,
  richtung      text not null check (richtung in ('fahrer', 'team')),
  text          text not null check (char_length(btrim(text)) between 1 and 2000),
  kopf          jsonb,                       -- Snapshot {name, fahrer_nr, kennzeichen, modell} beim Senden
  team_name     text,                        -- Telegram-Vorname des Teammitglieds
  tg_message_id bigint,                      -- fahrer: Post des Bots; team: Nachricht des Teammitglieds
  tg_versuche   integer not null default 0,
  tg_fehler     text,
  gelesen_am    timestamptz,
  erstellt_am   timestamptz not null default now()
);
create index if not exists nachrichten_fahrer_zeit on public.nachrichten (fahrer_nr, erstellt_am desc);
-- Telegram wiederholt Webhooks: dieselbe Team-Nachricht nur einmal
create unique index if not exists nachrichten_team_tg_einmal on public.nachrichten (tg_message_id) where richtung = 'team';
create index if not exists nachrichten_offen on public.nachrichten (id) where richtung = 'fahrer' and tg_message_id is null;

-- Ein Telegram-Thema je Fahrer. thread_id null = wird gerade angelegt (Reservierung)
create table if not exists public.tg_themen (
  fahrer_nr   integer primary key,
  thread_id   bigint unique,
  name        text,
  kennzeichen text,
  erstellt_am timestamptz not null default now()
);

create table if not exists public.push_abos (
  id          bigint generated always as identity primary key,
  fahrer_nr   integer not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  erstellt_am timestamptz not null default now()
);
create index if not exists push_abos_fahrer on public.push_abos (fahrer_nr);

alter table public.nachrichten enable row level security;
alter table public.tg_themen enable row level security;
alter table public.push_abos enable row level security;
revoke all on public.nachrichten, public.tg_themen, public.push_abos from public, anon, authenticated;
grant select on public.nachrichten to authenticated;
drop policy if exists nachrichten_buero_liest on public.nachrichten;
create policy nachrichten_buero_liest on public.nachrichten for select to authenticated using (public.is_app_user());
grant all on public.nachrichten, public.tg_themen, public.push_abos to service_role;

-- Notion-Nr. des Ziels (Fahrer selbst oder Buero-Vorschau), null wenn keiner
create or replace function public.nachrichten_nr(p_fahrer_id integer) returns integer
language sql stable security definer set search_path = public as $$
  select f.notion_fahrer_id from public.fahrer f where f.id = public.fahrer_app_ziel(p_fahrer_id)
$$;

-- Nur echte Push-Dienste (sonst koennte ein Fahrer push-senden an beliebige Adressen schicken lassen)
create or replace function public.push_endpoint_erlaubt(p text) returns boolean
language sql immutable as $$
  select coalesce(p, '') ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
$$;

create or replace function public.fahrer_app_nachrichten(p_fahrer_id integer default null)
returns table (id bigint, richtung text, text text, team_name text, erstellt_am timestamptz, gelesen_am timestamptz)
language sql stable security definer set search_path = public as $$
  select x.id, x.richtung, x.text, x.team_name, x.erstellt_am, x.gelesen_am
  from (select n.* from public.nachrichten n
        where n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
        order by n.erstellt_am desc, n.id desc limit 50) x
  order by x.erstellt_am, x.id
$$;

create or replace function public.fahrer_app_nachricht_senden(p_text text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_p    record;
  v_id   bigint;
begin
  if public.is_app_user() or public.mein_fahrer_id() is null then
    raise exception 'Nachrichten senden kann nur der Fahrer selbst' using errcode = '42501';
  end if;
  select * into v_p from public.fahrer_app_profil(null) limit 1;
  if v_p.fahrer_nr is null then
    raise exception 'Nachrichten senden kann nur der Fahrer selbst' using errcode = '42501';
  end if;
  if char_length(v_text) = 0 then raise exception 'Nachricht ist leer'; end if;
  if char_length(v_text) > 2000 then raise exception 'Nachricht ist zu lang (höchstens 2000 Zeichen)'; end if;
  if (select count(*) from public.nachrichten n
      where n.fahrer_nr = v_p.fahrer_nr and n.richtung = 'fahrer' and n.erstellt_am > now() - interval '10 minutes') >= 10 then
    raise exception 'Zu viele Nachrichten – bitte kurz warten';
  end if;
  insert into public.nachrichten (fahrer_nr, richtung, text, kopf)
  values (v_p.fahrer_nr, 'fahrer', v_text, jsonb_build_object(
    'name', v_p.name, 'fahrer_nr', v_p.fahrer_nr,
    'kennzeichen', nullif(btrim(coalesce(v_p.kennzeichen, '')), ''),
    'modell', nullif(btrim(coalesce(v_p.fahrzeug_modell, '')), '')))
  returning nachrichten.id into v_id;
  return v_id;
end $$;

create or replace function public.fahrer_app_nachrichten_gelesen() returns integer
language plpgsql security definer set search_path = public as $$
declare v_nr integer; v_n integer;
begin
  if public.is_app_user() then return 0; end if;          -- Vorschau setzt nichts
  v_nr := public.nachrichten_nr(null);
  if v_nr is null then return 0; end if;
  update public.nachrichten set gelesen_am = now()
   where fahrer_nr = v_nr and richtung = 'team' and gelesen_am is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.fahrer_app_push_abo(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare v_nr integer;
begin
  if public.is_app_user() then raise exception 'In der Vorschau nicht möglich' using errcode = '42501'; end if;
  v_nr := public.nachrichten_nr(null);
  if v_nr is null then raise exception 'Nachrichten nur für Fahrer' using errcode = '42501'; end if;
  if not public.push_endpoint_erlaubt(p_endpoint) then raise exception 'Push-Adresse ungültig'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_=-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_=-]{16,32}$' then
    raise exception 'Push-Schlüssel ungültig';
  end if;
  -- ein Geraet gehoert immer dem zuletzt angemeldeten Fahrer
  insert into public.push_abos (fahrer_nr, endpoint, p256dh, auth) values (v_nr, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set fahrer_nr = excluded.fahrer_nr, p256dh = excluded.p256dh,
                                       auth = excluded.auth, erstellt_am = now();
end $$;

-- Atomar: nur wer reserviert, legt das Thema in Telegram an (zwei schnelle Nachrichten -> ein Thema).
-- Haengt eine Reservierung > 2 Minuten (Function abgebrochen), darf sie neu uebernommen werden.
create or replace function public.tg_thema_reservieren(p_fahrer_nr integer)
returns table (thread_id bigint, name text, kennzeichen text, reserviert boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  insert into public.tg_themen (fahrer_nr) values (p_fahrer_nr) on conflict (fahrer_nr) do nothing;
  if found then return query select null::bigint, null::text, null::text, true; return; end if;
  update public.tg_themen t set erstellt_am = now()
   where t.fahrer_nr = p_fahrer_nr and t.thread_id is null and t.erstellt_am < now() - interval '2 minutes';
  if found then return query select null::bigint, null::text, null::text, true; return; end if;
  return query select t.thread_id, t.name, t.kennzeichen, false from public.tg_themen t where t.fahrer_nr = p_fahrer_nr;
end $$;

-- Neue Zeile -> Edge Function (pg_net, nach dem Commit). Darf das Speichern nie blockieren.
create or replace function public.nachrichten_weiterleiten() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/'
             || case new.richtung when 'fahrer' then 'telegram-senden' else 'push-senden' end,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := jsonb_build_object('id', new.id),
      timeout_milliseconds := 30000);
  exception when others then
    raise warning 'nachrichten_weiterleiten(%): %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists nachrichten_weiterleiten on public.nachrichten;
create trigger nachrichten_weiterleiten after insert on public.nachrichten
  for each row execute function public.nachrichten_weiterleiten();

revoke all on function public.nachrichten_nr(integer), public.tg_thema_reservieren(integer),
  public.nachrichten_weiterleiten() from public, anon, authenticated;
grant execute on function public.tg_thema_reservieren(integer) to service_role;
revoke all on function public.fahrer_app_nachrichten(integer), public.fahrer_app_nachricht_senden(text),
  public.fahrer_app_nachrichten_gelesen(), public.fahrer_app_push_abo(text, text, text) from public, anon;
grant execute on function public.fahrer_app_nachrichten(integer), public.fahrer_app_nachricht_senden(text),
  public.fahrer_app_nachrichten_gelesen(), public.fahrer_app_push_abo(text, text, text) to authenticated;

-- Nachhol-Lauf: was nach 2 Minuten nicht in Telegram ist, nochmal (die Function nimmt sie der Reihe nach)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'nachrichten-nachholen') then
    perform cron.unschedule('nachrichten-nachholen');
  end if;
  perform cron.schedule('nachrichten-nachholen', '*/5 * * * *', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-senden',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"nachholen": true}'::jsonb, timeout_milliseconds := 120000)
    where exists (select 1 from public.nachrichten where richtung = 'fahrer' and tg_message_id is null
                  and tg_versuche < 5 and erstellt_am < now() - interval '2 minutes');
  $job$);
end $$;
