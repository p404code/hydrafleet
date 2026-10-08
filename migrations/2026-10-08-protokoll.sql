-- Protokoll: wer hat was geaendert. Spec: docs/superpowers/specs/2026-10-08-protokoll-design.md
-- * Die Datenbank schreibt selbst mit (Trigger protokoll_mitschreiben), nicht das Dashboard.
-- * Wer = auth.jwt(): Buero-Name, Fahrer-Nr., service_role (Automatik) oder kein JWT (SQL-Fenster).
-- * protokoll ist gesperrt: kein UPDATE/DELETE/TRUNCATE, auch nicht im SQL-Fenster.
-- * Lesen nur is_app_admin(). NICHT aufweichen.
-- Wiederholbar; ohne begin/commit.

create table if not exists public.protokoll (
  id         bigint generated always as identity primary key,
  zeit       timestamptz not null default now(),
  akteur_art text not null check (akteur_art in ('buero', 'fahrer', 'automatik', 'sql')),
  akteur     text not null,
  auth_uid   uuid,
  tabelle    text not null,
  aktion     text not null check (aktion in ('neu', 'geaendert', 'geloescht')),
  zeile      text,                 -- Primaerschluessel als Text, Teile mit / verbunden
  fahrer     text,
  woche      text,
  felder     text[],               -- geaenderte Spalten (nur bei geaendert)
  alt        jsonb,
  neu        jsonb,
  altbestand boolean not null default false
);
create index if not exists protokoll_zeit_idx on public.protokoll (zeit desc);
create index if not exists protokoll_tabelle_zeit_idx on public.protokoll (tabelle, zeit desc);

alter table public.protokoll enable row level security;
revoke all on public.protokoll from public, anon, authenticated, service_role;
grant select on public.protokoll to authenticated;
drop policy if exists protokoll_nur_admin on public.protokoll;
create policy protokoll_nur_admin on public.protokoll for select to authenticated using (public.is_app_admin());

create or replace function public.protokoll_gesperrt() returns trigger
language plpgsql as $$
begin
  raise exception 'Das Protokoll wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists protokoll_gesperrt on public.protokoll;
create trigger protokoll_gesperrt before update or delete on public.protokoll
  for each row execute function public.protokoll_gesperrt();
drop trigger if exists protokoll_gesperrt_alles on public.protokoll;
create trigger protokoll_gesperrt_alles before truncate on public.protokoll
  for each statement execute function public.protokoll_gesperrt();

-- Nur ueberwachte Spalten behalten. modus 'nur' = nur diese, 'ohne' = alle ausser diesen.
create or replace function public.protokoll_filter(p_zeile jsonb, p_modus text, p_spalten text[])
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(p_zeile) e
   where case when p_modus = 'nur' then e.key = any (p_spalten) else not (e.key = any (p_spalten)) end
$$;

-- Trigger-Argumente: (pk-spalten, modus, spalten, flag)
--   pk-spalten  'id' oder 'firma_nr,ma_nr'
--   modus       'ohne' | 'nur'
--   spalten     kommagetrennt, darf leer sein
--   flag        'ohne_neu' = INSERT nicht protokollieren
create or replace function public.protokoll_schreiben() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pk      text[] := string_to_array(tg_argv[0], ',');
  v_modus   text   := tg_argv[1];
  v_spalten text[] := string_to_array(coalesce(tg_argv[2], ''), ',');
  v_jwt jsonb; v_art text; v_wer text; v_uid uuid;
  v_voll jsonb; v_alt jsonb; v_neu jsonb; v_felder text[]; v_zeile text; v_fahrer text; v_fid text;
begin
  if tg_op = 'INSERT' and coalesce(tg_argv[3], '') = 'ohne_neu' then return null; end if;
  -- Ein Fehler hier darf den eigentlichen Schreibvorgang nie scheitern lassen.
  begin
    v_jwt := auth.jwt();
    if nullif(btrim(v_jwt->'app_metadata'->>'app_name'), '') is not null then
      v_art := 'buero';     v_wer := btrim(v_jwt->'app_metadata'->>'app_name');
    elsif nullif(v_jwt->'app_metadata'->>'fahrer_nr', '') is not null then
      v_art := 'fahrer';    v_wer := 'Fahrer ' || (v_jwt->'app_metadata'->>'fahrer_nr');
    elsif v_jwt->>'role' = 'service_role' then
      v_art := 'automatik'; v_wer := 'Automatik';
    elsif v_jwt is null then
      v_art := 'sql';       v_wer := 'SQL-Fenster';
    else
      v_art := 'sql';       v_wer := 'Unbekannt (' || coalesce(v_jwt->>'role', '?') || ')';
    end if;
    if (v_jwt->>'sub') ~ '^[0-9a-f-]{36}$' then v_uid := (v_jwt->>'sub')::uuid; end if;

    if tg_op = 'DELETE' then v_voll := to_jsonb(old); else v_voll := to_jsonb(new); end if;
    if tg_op <> 'INSERT' then v_alt := public.protokoll_filter(to_jsonb(old), v_modus, v_spalten); end if;
    if tg_op <> 'DELETE' then v_neu := public.protokoll_filter(to_jsonb(new), v_modus, v_spalten); end if;
    if tg_op = 'UPDATE' then
      select array_agg(k order by k) into v_felder
        from jsonb_object_keys(v_neu) k where v_alt->k is distinct from v_neu->k;
      if v_felder is null then return null; end if;
    end if;

    select string_agg(v_voll->>u.k, '/' order by u.ord) into v_zeile
      from unnest(v_pk) with ordinality u(k, ord);
    v_fahrer := nullif(v_voll->>'fahrer_name', '');
    if v_fahrer is null then
      v_fid := coalesce(v_voll->>'notion_fahrer_id', v_voll->>'fahrer_id');
      if v_fid ~ '^[0-9]+$' then
        select f.name into v_fahrer from public.notion_fahrer f where f.notion_fahrer_id = v_fid::int limit 1;
        v_fahrer := coalesce(v_fahrer, 'Fahrer-ID ' || v_fid);
      end if;
    end if;

    insert into public.protokoll (akteur_art, akteur, auth_uid, tabelle, aktion, zeile, fahrer, woche, felder, alt, neu)
    values (v_art, v_wer, v_uid, tg_table_name,
            case tg_op when 'INSERT' then 'neu' when 'UPDATE' then 'geaendert' else 'geloescht' end,
            v_zeile, v_fahrer, nullif(v_voll->>'woche', ''), v_felder, v_alt, v_neu);
  exception when others then
    raise warning 'protokoll_schreiben(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.protokoll_schreiben() from public, anon, authenticated;

-- Trigger je Tabelle. Neue Tabelle ueberwachen = hier eine Zeile anhaengen.
do $$
declare r record;
begin
  for r in select * from (values
    ('settlements',          'id',                   'ohne', 'telegram_gesendet,created_at', ''),
    ('abrechnung_posten',    'id',                   'ohne', '', ''),
    ('kassier_zahlungen',    'id',                   'ohne', '', ''),
    ('abrechnung_freigaben', 'woche',                'ohne', '', ''),
    ('post_eingang',         'id',                   'nur',  'fahrer_id,status,freigegeben_am,freigegeben_von,erledigt_am,erledigt_von,notiz,betrag,art', 'ohne_neu'),
    ('mietverhaeltnisse',    'id',                   'ohne', '', ''),
    ('zuordnung_manuell',    'anbieter,driver_uuid', 'ohne', '', ''),
    ('lohn_personen',        'firma_nr,ma_nr',       'ohne', '', ''),
    ('name_aliases',         'csv_name',             'ohne', '', ''),
    ('fahrer_app_zugang',    'notion_fahrer_id',     'ohne', '', ''),
    ('customers',            'id',                   'ohne', '', ''),
    ('companies',            'id',                   'ohne', '', '')
  ) t(tab, pk, modus, spalten, flag) loop
    execute format('drop trigger if exists protokoll_mitschreiben on public.%I', r.tab);
    execute format('create trigger protokoll_mitschreiben after insert or update or delete on public.%I
                    for each row execute function public.protokoll_schreiben(%L, %L, %L, %L)',
                   r.tab, r.pk, r.modus, r.spalten, r.flag);
  end loop;
end $$;
