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

-- === Verlauf: protokoll + sync_runs + post_ausgang + kassabuch, nur admin ===
create or replace function public.protokoll_bereich(p_tabelle text) returns text
language sql immutable as $$
  select case p_tabelle
    when 'settlements' then 'geld' when 'abrechnung_posten' then 'geld' when 'kassier_zahlungen' then 'geld'
    when 'abrechnung_freigaben' then 'freigaben'
    when 'post_eingang' then 'post' when 'mietverhaeltnisse' then 'post' when 'post_ausgang' then 'post'
    when 'zuordnung_manuell' then 'zuordnungen' when 'lohn_personen' then 'zuordnungen' when 'name_aliases' then 'zuordnungen'
    when 'fahrer_app_zugang' then 'zugaenge'
    when 'customers' then 'stammdaten' when 'companies' then 'stammdaten'
    when 'kassabuch' then 'kassa' when 'sync_runs' then 'sync'
    else 'sonst' end
$$;

create or replace function public.protokoll_verlauf(
  p_art text default null, p_akteur text default null, p_bereich text default null, p_fahrer text default null,
  p_von date default null, p_bis date default null, p_nur_loeschungen boolean default false,
  p_limit int default 100, p_offset int default 0)
returns table (zeit timestamptz, quelle text, akteur_art text, akteur text, auftrag text, tabelle text, bereich text,
               aktion text, zeile text, fahrer text, woche text, anzahl int, ids bigint[], felder text[],
               alt jsonb, neu jsonb, altbestand boolean)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_app_admin() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  return query
  with p as (
    -- Automatik-Zeilen gleicher Tabelle/Woche/Minute werden zu einer Sammelzeile
    select max(x.zeit) as zeit, 'protokoll'::text as quelle, x.akteur_art, x.akteur,
           case when count(*) = 1 and x.akteur_art = 'automatik' and min(x.aktion) = 'neu'
                then nullif(coalesce((array_agg(x.neu))[1]->>'angelegt_von', (array_agg(x.neu))[1]->>'gesetzt_von'), '') end as auftrag,
           x.tabelle, public.protokoll_bereich(x.tabelle) as bereich,
           case when min(x.aktion) = max(x.aktion) then min(x.aktion) else 'gemischt' end as aktion,
           case when count(*) = 1 then min(x.zeile) end as zeile,
           case when count(*) = 1 then min(x.fahrer) end as fahrer,
           x.woche, count(*)::int as anzahl,
           case when count(*) > 1 then array_agg(x.id order by x.id) end as ids,
           case when count(*) = 1 then min(x.id) end as eine_id,
           case when count(*) = 1 then (array_agg(x.alt))[1] end as alt,
           case when count(*) = 1 then (array_agg(x.neu))[1] end as neu,
           x.altbestand
      from public.protokoll x
     where (p_fahrer is null or x.fahrer ilike '%' || p_fahrer || '%')
       and (not p_nur_loeschungen or x.aktion = 'geloescht')
     group by x.akteur_art, x.akteur, x.tabelle, x.woche, x.altbestand,
              case when x.akteur_art = 'automatik' and not x.altbestand then date_trunc('minute', x.zeit) end,
              case when x.akteur_art = 'automatik' and not x.altbestand then null else x.id end
  ), alle as (
    select p.zeit, p.quelle, p.akteur_art, p.akteur, p.auftrag, p.tabelle, p.bereich, p.aktion, p.zeile, p.fahrer,
           p.woche, p.anzahl, p.ids,
           (select q.felder from public.protokoll q where q.id = p.eine_id) as felder,
           p.alt, p.neu, p.altbestand
      from p
    union all
    -- Sync-Laeufe: je Verbindung, Wiener Tag und Status eine Zeile
    select max(coalesce(s.ende, s.start)), 'sync'::text, 'automatik'::text, 'Automatik'::text, null::text,
           'sync_runs'::text, 'sync'::text, s.status, null::text, null::text, null::text, count(*)::int,
           null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('anbieter', v.anbieter, 'firma', v.firma, 'zeilen', sum(s.anzahl), 'fehler', max(s.fehler)),
           false
      from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
     where s.status <> 'laeuft'
     group by v.id, v.anbieter, v.firma, s.status, (coalesce(s.ende, s.start) at time zone 'Europe/Vienna')::date
    union all
    select a.gesendet_am, 'post'::text, case when u.name is null then 'automatik' else 'buero' end,
           coalesce(u.name, 'Automatik'), null::text, 'post_ausgang'::text, 'post'::text, 'gesendet'::text,
           a.id::text, null::text, null::text, 1, null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('an', a.an, 'gz', a.gz, 'betreff', a.betreff, 'test_an', a.test_an, 'quelle', a.quelle),
           false
      from public.post_ausgang a left join public.app_users u on u.auth_id = a.gesendet_von
     where a.gesendet_am is not null
    union all
    select k.angelegt_am, 'kassa'::text, 'buero'::text, coalesce(nullif(k.name, ''), nullif(k.angelegt_von, ''), 'unbekannt'),
           null::text, 'kassabuch'::text, 'kassa'::text, case when k.storno_von is not null then 'storno' else k.art end,
           k.nr::text, null::text, k.woche_abr, 1, null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('nr', k.nr, 'datum', k.datum, 'art', k.art, 'betrag', k.betrag, 'text', k.text,
                              'quelle', k.quelle, 'storno_von', k.storno_von),
           false
      from public.kassabuch k
  )
  select a.zeit, a.quelle, a.akteur_art, a.akteur, a.auftrag, a.tabelle, a.bereich, a.aktion, a.zeile, a.fahrer,
         a.woche, a.anzahl, a.ids, a.felder, a.alt, a.neu, a.altbestand
    from alle a
   where a.zeit is not null
     and (p_art is null or (p_art = 'automatik' and a.akteur_art = 'automatik')
                        or (p_art = 'mensch' and a.akteur_art <> 'automatik'))
     and (p_akteur is null or a.akteur = p_akteur or a.auftrag = p_akteur)
     and (p_bereich is null or a.bereich = p_bereich)
     and (p_fahrer is null or a.quelle = 'protokoll')
     and (not p_nur_loeschungen or a.quelle = 'protokoll' or a.aktion = 'storno')
     and (p_von is null or (a.zeit at time zone 'Europe/Vienna')::date >= p_von)
     and (p_bis is null or (a.zeit at time zone 'Europe/Vienna')::date <= p_bis)
   order by a.zeit desc, a.quelle, a.tabelle, a.zeile
   limit least(greatest(coalesce(p_limit, 100), 1), 1000) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.protokoll_verlauf(text, text, text, text, date, date, boolean, int, int) from public, anon;
grant execute on function public.protokoll_verlauf(text, text, text, text, date, date, boolean, int, int) to authenticated;

-- === Altbestand: einmalig, was schon einen Namen traegt ===
do $$
begin
  if exists (select 1 from public.protokoll where altbestand) then return; end if;
  insert into public.protokoll (zeit, akteur_art, akteur, tabelle, aktion, zeile, fahrer, woche, neu, altbestand)
  select coalesce(f.freigegeben_am, now()), 'buero', coalesce(nullif(f.freigegeben_von, ''), 'unbekannt'),
         'abrechnung_freigaben', 'neu', f.woche, null, f.woche, to_jsonb(f), true
    from public.abrechnung_freigaben f
  union all
  select coalesce(p.angelegt_am, now()), 'buero', coalesce(nullif(p.angelegt_von, ''), 'unbekannt'),
         'abrechnung_posten', 'neu', p.id::text, p.fahrer_name, p.woche, to_jsonb(p), true
    from public.abrechnung_posten p
  union all
  select coalesce(z.kassiert_at, now()), 'buero', coalesce(nullif(z.kassiert_von, ''), 'unbekannt'),
         'kassier_zahlungen', 'neu', z.id::text, z.fahrer_name, z.woche, to_jsonb(z), true
    from public.kassier_zahlungen z
  union all
  select coalesce(m.gesetzt_am, now()), 'buero', coalesce(nullif(m.gesetzt_von, ''), 'unbekannt'),
         'zuordnung_manuell', 'neu', m.anbieter || '/' || m.driver_uuid,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = m.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || m.notion_fahrer_id), null, to_jsonb(m), true
    from public.zuordnung_manuell m
  union all
  select coalesce(l.gesetzt_am, now()), 'buero', coalesce(nullif(l.gesetzt_von, ''), 'unbekannt'),
         'lohn_personen', 'neu', l.firma_nr || '/' || l.ma_nr,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = l.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || l.notion_fahrer_id), null, to_jsonb(l), true
    from public.lohn_personen l
  union all
  select coalesce(a.angelegt_am, now()), 'buero', coalesce(nullif(a.angelegt_von, ''), 'unbekannt'),
         'fahrer_app_zugang', 'neu', a.notion_fahrer_id::text,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = a.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || a.notion_fahrer_id), null, to_jsonb(a), true
    from public.fahrer_app_zugang a;
end $$;
