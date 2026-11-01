-- ============================================================================
-- Autoliste: Fahrer↔Auto in HYDRAlink
-- Spec: docs/superpowers/specs/2026-11-01-autoliste-design.md · Plan: docs/superpowers/plans/2026-11-01-autoliste.md
-- Datum: 2026-11-01
--
-- * fahrer_auto: Verlauf (nur anhängen), je Fahrer gilt die letzte Zeile (kennzeichen_key null = kein Auto)
-- * auto_fahrer_setzen / auto_fahrer_entfernen: einziger Schreibweg fürs Büro, setzen fahrer + Pauschale mit,
--   merken die betroffenen Autos in fuhrpark_notion_offen fürs Zurückschreiben nach Notion vor
-- * fahrer_auto_uebernehmen: Startstand aus Notion („Fahrer aktuell“), nur Fahrer mit fahrer-Zeile
-- * fuhrpark bekommt notion_page_id + notion_fahrer (Notion-Spiegel, notion-sync füllt sie)
-- * View autoliste fürs Dashboard
-- Der Wächter fürs Kennzeichen kommt erst mit 2026-11-01-autoliste-scharf.sql.
--
-- Rollback: drop view autoliste, fahrer_auto_aktuell; drop function auto_fahrer_setzen, auto_fahrer_entfernen,
--   fahrer_auto_uebernehmen, kennzeichen_anzeige, telefon_wie_fullsync, fahrer_auto_gesperrt;
--   drop table fuhrpark_notion_offen, fahrer_auto; alter table fuhrpark drop column notion_page_id, drop column notion_fahrer;
--   fuhrpark_ersetzen, pauschale_setzen, protokoll_bereich aus ihren vorigen Migrationen neu anlegen
-- ============================================================================

alter table public.fuhrpark add column if not exists notion_page_id text, add column if not exists notion_fahrer integer[];

create table if not exists public.fahrer_auto (
  id               bigint generated always as identity primary key,
  notion_fahrer_id integer not null,
  kennzeichen_key  text,
  kennzeichen      text,
  quelle           text not null check (quelle in ('hand', 'uebernahme', 'notion')),
  von              text not null,
  am               timestamptz not null default now(),
  check ((kennzeichen_key is null) = (kennzeichen is null))
);
create index if not exists fahrer_auto_nr on public.fahrer_auto (notion_fahrer_id, am desc, id desc);
create table if not exists public.fuhrpark_notion_offen (
  kennzeichen_key text primary key,
  seit            timestamptz not null default now()
);

create or replace function public.fahrer_auto_gesperrt() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Der Auto-Verlauf wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists fahrer_auto_gesperrt on public.fahrer_auto;
create trigger fahrer_auto_gesperrt before update or delete on public.fahrer_auto
  for each row execute function public.fahrer_auto_gesperrt();
drop trigger if exists fahrer_auto_gesperrt_alles on public.fahrer_auto;
create trigger fahrer_auto_gesperrt_alles before truncate on public.fahrer_auto
  for each statement execute function public.fahrer_auto_gesperrt();
drop trigger if exists protokoll_mitschreiben on public.fahrer_auto;
create trigger protokoll_mitschreiben after insert on public.fahrer_auto
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

alter table public.fahrer_auto enable row level security;
alter table public.fuhrpark_notion_offen enable row level security;
revoke all on public.fahrer_auto, public.fuhrpark_notion_offen from public, anon, authenticated;
grant select on public.fahrer_auto, public.fuhrpark_notion_offen to authenticated;
drop policy if exists buero_liest on public.fahrer_auto;
create policy buero_liest on public.fahrer_auto for select to authenticated using (public.is_app_user());
drop policy if exists buero_liest on public.fuhrpark_notion_offen;
create policy buero_liest on public.fuhrpark_notion_offen for select to authenticated using (public.is_app_user());

create or replace view public.fahrer_auto_aktuell with (security_invoker = true) as
  select distinct on (notion_fahrer_id) * from public.fahrer_auto order by notion_fahrer_id, am desc, id desc;

-- wie der n8n-Full-Sync: Teil vor "(", Leerzeichen zusammengezogen
create or replace function public.kennzeichen_anzeige(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(split_part(coalesce(p, ''), '(', 1), '\s+', ' ', 'g')), '')
$$;

-- wie der n8n-Full-Sync („Merge All Data“)
create or replace function public.telefon_wie_fullsync(p text) returns text
language sql immutable set search_path = public as $$
  select case when t = '' then null
              when t like '0043%' then '+43' || substr(t, 5)
              when t like '00%' then '+' || substr(t, 3)
              when t like '0%' then '+43' || substr(t, 2)
              when t like '+%' then t
              else '+43' || t end
    from (select regexp_replace(coalesce(p, ''), '[\s/-]', '', 'g') as t) x
$$;

-- ---------- fuhrpark_ersetzen: + notion_page_id, notion_fahrer ----------
create or replace function public.fuhrpark_ersetzen(p_zeilen jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with roh as (
    select * from jsonb_to_recordset(p_zeilen) as x(
      kennzeichen text, modell text, firma text, pauschale numeric,
      pauschal_modell text, eigentuemer jsonb, vin text, kilometerstand text,
      ablauf_pickerl date, polizze text, versicherung_monatlich text,
      taxameter jsonb, bolt_werbung boolean, dashcam boolean,
      notion_page_id text, notion_fahrer jsonb)
  ),
  -- Zwei Notion-Zeilen koennen auf dasselbe normalisierte Kennzeichen fallen.
  -- Ohne Entdopplung bricht ON CONFLICT ab ("cannot affect row a second time").
  z as (
    select distinct on (public.kennzeichen_key(kennzeichen)) *
    from roh where public.kennzeichen_key(kennzeichen) <> ''
    order by public.kennzeichen_key(kennzeichen), pauschale desc nulls last
  ),
  ein as (
    insert into public.fuhrpark (
      kennzeichen_key, kennzeichen, modell, firma, pauschale, pauschal_modell,
      eigentuemer, vin, kilometerstand, ablauf_pickerl, polizze,
      versicherung_monatlich, taxameter, bolt_werbung, dashcam, notion_page_id, notion_fahrer, aktualisiert_am)
    select public.kennzeichen_key(z.kennzeichen), z.kennzeichen, z.modell, z.firma,
           z.pauschale, z.pauschal_modell,
           case when z.eigentuemer is null then null
                else array(select jsonb_array_elements_text(z.eigentuemer)) end,
           z.vin, z.kilometerstand, z.ablauf_pickerl, z.polizze, z.versicherung_monatlich,
           case when z.taxameter is null then null
                else array(select jsonb_array_elements_text(z.taxameter)) end,
           z.bolt_werbung, z.dashcam, z.notion_page_id,
           case when z.notion_fahrer is null then null
                else array(select (jsonb_array_elements_text(z.notion_fahrer))::integer) end,
           now()
    from z
    on conflict (kennzeichen_key) do update set
      kennzeichen = excluded.kennzeichen, modell = excluded.modell,
      firma = excluded.firma, pauschale = excluded.pauschale,
      pauschal_modell = excluded.pauschal_modell, eigentuemer = excluded.eigentuemer,
      vin = excluded.vin, kilometerstand = excluded.kilometerstand,
      ablauf_pickerl = excluded.ablauf_pickerl, polizze = excluded.polizze,
      versicherung_monatlich = excluded.versicherung_monatlich,
      taxameter = excluded.taxameter, bolt_werbung = excluded.bolt_werbung,
      dashcam = excluded.dashcam, notion_page_id = excluded.notion_page_id,
      notion_fahrer = excluded.notion_fahrer, aktualisiert_am = now()
    returning 1
  )
  select count(*) into n from ein;
  return n;
end $$;

-- ---------- pauschale_setzen: auch Fahrer, die nur in Notion stehen (Pavel-Fall) ----------
-- Nur die eine Prüfung im live gespeicherten Text ersetzen, damit nichts anderes abweicht.
do $$
declare
  d   text := pg_get_functiondef('public.pauschale_setzen(integer, text, numeric, numeric, numeric, text, text, text)'::regprocedure);
  alt text := 'if not exists (select 1 from public.fahrer where notion_fahrer_id = p_nr) then';
  neu text := 'if not exists (select 1 from public.fahrer where notion_fahrer_id = p_nr)
     and not exists (select 1 from public.notion_fahrer where notion_fahrer_id = p_nr) then';
begin
  if position(alt in d) = 0 then
    if position('public.notion_fahrer where notion_fahrer_id = p_nr' in d) > 0 then return; end if;
    raise exception 'pauschale_setzen: Stelle nicht gefunden – bitte von Hand prüfen';
  end if;
  execute replace(d, alt, neu);
end $$;

-- ---------- Setzen / Entfernen ----------
create or replace function public.auto_fahrer_setzen(
  p_kennzeichen_key text, p_nr integer, p_art text default null, p_betrag numeric default null,
  p_prozent_satz numeric default null, p_prozent_schwelle numeric default null,
  p_gilt_ab text default null, p_gilt_bis text default null, p_grund text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_auto  public.fuhrpark;
  v_nf    public.notion_fahrer;
  v_alt   public.fahrer_auto;
  v_wer   text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
  v_kz    text;
  v_fid   integer;
  v_autos text[];
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_auto from public.fuhrpark where kennzeichen_key = p_kennzeichen_key;
  if v_auto.kennzeichen_key is null or coalesce(v_auto.firma, '') = 'Abgemeldet' then
    raise exception 'Auto % ist nicht angemeldet', p_kennzeichen_key using errcode = '22023'; end if;
  select * into v_nf from public.notion_fahrer where notion_fahrer_id = p_nr order by aktualisiert_am desc limit 1;
  if v_nf.notion_fahrer_id is null or nullif(btrim(v_nf.name), '') is null then
    raise exception 'Fahrer Nr. % ist nicht in Notion', p_nr using errcode = '22023'; end if;

  if p_art is not null then
    perform public.pauschale_setzen(p_nr, p_art, p_betrag, p_prozent_satz, p_prozent_schwelle, p_gilt_ab, p_gilt_bis, p_grund);
  elsif (public.pauschale_fuer(p_nr, public.pauschale_stichwoche())).id is null then
    raise exception 'Pauschale fehlt – bitte für % festlegen', btrim(v_nf.name) using errcode = '22023';
  end if;

  v_kz := public.kennzeichen_anzeige(v_auto.kennzeichen);
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  values (p_nr, p_kennzeichen_key, v_kz, 'hand', v_wer);

  select max(id) into v_fid from public.fahrer where notion_fahrer_id = p_nr;
  if v_fid is null then
    -- Name wie der n8n-Full-Sync (upsert on_conflict=name); Pauschale setzt der Wächter aus dem Verlauf
    insert into public.fahrer (name, telefon, kennzeichen, aktiv, notion_fahrer_id, mietmodell, basis_miete, prozent_satz, prozent_schwelle)
    values (btrim(v_nf.name), public.telefon_wie_fullsync(v_nf.telefon), v_kz, true, p_nr, 'fix', 0, 0, 0);
  else
    update public.fahrer set kennzeichen = v_kz, aktiv = true where id = v_fid;
  end if;
  perform public.pauschalen_anwenden(p_nr);

  v_autos := array_remove(array[p_kennzeichen_key,
    case when v_alt.kennzeichen_key is distinct from p_kennzeichen_key then v_alt.kennzeichen_key end], null);
  insert into public.fuhrpark_notion_offen (kennzeichen_key) select unnest(v_autos) on conflict do nothing;
  return jsonb_build_object('autos', to_jsonb(v_autos));
end $$;

create or replace function public.auto_fahrer_entfernen(p_nr integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alt public.fahrer_auto;
  v_wer text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  if v_alt.kennzeichen_key is null then return jsonb_build_object('autos', '[]'::jsonb); end if;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  values (p_nr, null, null, 'hand', v_wer);
  -- aktiv bleibt: Umsätze der laufenden Woche werden noch abgerechnet
  update public.fahrer set kennzeichen = null where id = (select max(id) from public.fahrer where notion_fahrer_id = p_nr);
  insert into public.fuhrpark_notion_offen (kennzeichen_key) values (v_alt.kennzeichen_key) on conflict do nothing;
  return jsonb_build_object('autos', jsonb_build_array(v_alt.kennzeichen_key));
end $$;

-- ---------- Start: Notion-Stand übernehmen ----------
-- Nur Fahrer mit fahrer-Zeile und noch ohne Verlauf. Steht einer in Notion auf zwei Autos:
-- das, auf dem er laut fahrer.kennzeichen sitzt, sonst das erste.
create or replace function public.fahrer_auto_uebernehmen() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  select distinct on (x.nr) x.nr, x.kennzeichen_key, public.kennzeichen_anzeige(x.kennzeichen), 'uebernahme', 'Übernahme aus Notion'
    from (select unnest(fp.notion_fahrer) as nr, fp.kennzeichen_key, fp.kennzeichen
            from public.fuhrpark fp where coalesce(fp.firma, '') <> 'Abgemeldet') x
    join public.fahrer f on f.notion_fahrer_id = x.nr and f.aktiv
   where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = x.nr)
   order by x.nr, (public.kennzeichen_key(f.kennzeichen) = x.kennzeichen_key) desc, x.kennzeichen_key;
  get diagnostics n = row_count;
  update public.fahrer f set kennzeichen = a.kennzeichen
    from public.fahrer_auto_aktuell a
   where a.notion_fahrer_id = f.notion_fahrer_id and f.aktiv and a.quelle = 'uebernahme'
     and f.kennzeichen is distinct from a.kennzeichen;
  return n;
end $$;

-- ---------- Liste fürs Dashboard ----------
create or replace view public.autoliste with (security_invoker = true) as
with s as (select public.pauschale_stichwoche() as w),
akt as (
  select a.notion_fahrer_id, a.kennzeichen_key, a.am, btrim(nf.name) as name,
         p.art, p.betrag, p.prozent_satz, p.prozent_schwelle
    from public.fahrer_auto_aktuell a
   cross join s
    left join lateral (select n.name from public.notion_fahrer n where n.notion_fahrer_id = a.notion_fahrer_id
                        order by n.aktualisiert_am desc limit 1) nf on true
    left join lateral public.pauschale_fuer(a.notion_fahrer_id, s.w) p on true
   where a.kennzeichen_key is not null
)
select fp.kennzeichen_key, fp.kennzeichen, fp.modell, fp.firma,
  coalesce((select jsonb_agg(jsonb_build_object('nr', akt.notion_fahrer_id, 'name', akt.name, 'art', akt.art,
              'betrag', akt.betrag, 'prozent_satz', akt.prozent_satz, 'prozent_schwelle', akt.prozent_schwelle, 'seit', akt.am)
              order by akt.name)
              from akt where akt.kennzeichen_key = fp.kennzeichen_key), '[]'::jsonb) as fahrer,
  coalesce((select jsonb_agg(jsonb_build_object('nr', u.nr, 'name', btrim(nf.name), 'telefon', nf.telefon) order by nf.name)
              from unnest(fp.notion_fahrer) as u(nr)
              join lateral (select n.name, n.telefon from public.notion_fahrer n where n.notion_fahrer_id = u.nr
                             order by n.aktualisiert_am desc limit 1) nf on true
             where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = u.nr)), '[]'::jsonb)
    as notion_nicht_uebernommen,
  exists (select 1 from public.fuhrpark_notion_offen o where o.kennzeichen_key = fp.kennzeichen_key) as notion_offen
from public.fuhrpark fp
where coalesce(fp.firma, '') <> 'Abgemeldet';

-- ---------- Rechte ----------
revoke all on function public.auto_fahrer_setzen(text, integer, text, numeric, numeric, numeric, text, text, text) from public, anon;
grant execute on function public.auto_fahrer_setzen(text, integer, text, numeric, numeric, numeric, text, text, text) to authenticated;
revoke all on function public.auto_fahrer_entfernen(integer) from public, anon;
grant execute on function public.auto_fahrer_entfernen(integer) to authenticated;
revoke all on function public.fahrer_auto_uebernehmen() from public, anon, authenticated;

-- ---------- Protokoll: fahrer_auto -> Bereich zuordnungen ----------
do $$
declare
  d   text := pg_get_functiondef('public.protokoll_bereich(text)'::regprocedure);
  alt text := 'when ''name_aliases'' then ''zuordnungen''';
begin
  if position('fahrer_auto' in d) > 0 then return; end if;
  if position(alt in d) = 0 then raise exception 'protokoll_bereich: Stelle nicht gefunden – bitte von Hand prüfen'; end if;
  execute replace(d, alt, alt || ' when ''fahrer_auto'' then ''zuordnungen''');
end $$;
