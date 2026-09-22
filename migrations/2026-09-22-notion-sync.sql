-- Notion-Sync: Spiegel der Fahrer-DB plus die Zuordnungslogik als Funktion.
-- Am 2026-09-22 eingespielt (notion_spiegel_und_zuordnung, fuhrpark_ersetzen_rpc).
-- Ergaenzt public.fuhrpark aus 2026-09-22-fuhrpark-spiegel.sql.
--
-- Notion bleibt Quelle und Logik. Diese Tabellen sind Lesekopien.
-- public.fahrer bleibt dem bestehenden n8n-Workflow vorbehalten - einzige
-- Ausnahme ist fahrer.notion_fahrer_id, und auch die nur, wo sie leer ist.

create table if not exists public.notion_fahrer (
  notion_page_id   text primary key,
  notion_fahrer_id integer,          -- "Fahrer ID", in der API ein unique_id
  name             text,             -- "Vor- Nachname"
  telefon          text,
  email            text,
  status           text,             -- NEU | Angemeldet | Abgemeldet
  firma            text,             -- "FA."
  roh              jsonb not null,
  sync_run_id      uuid references public.sync_runs(id) on delete set null,
  aktualisiert_am  timestamptz not null default now()
);
create index if not exists notion_fahrer_tel_idx on public.notion_fahrer (telefon);
create index if not exists notion_fahrer_nid_idx on public.notion_fahrer (notion_fahrer_id);

alter table public.notion_fahrer enable row level security;
drop policy if exists app_users_read on public.notion_fahrer;
create policy app_users_read on public.notion_fahrer
  for select to authenticated using (is_app_user());

-- Telefonnummern vergleichbar machen: 0676…, +43676…, 0043676… -> 43676…
create or replace function public.tel_key(t text) returns text
language sql immutable as $$
  select case when d like '00%' then substr(d, 3)
              when d like '0%'  then '43' || substr(d, 2)
              else d end
  from (select regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g') as d) x;
$$;

-- Namen vergleichbar machen: Gross/Klein, Satzzeichen und Wortreihenfolge egal.
-- Faengt "Jusupov Ruslan" <-> "Ruslan Jusupov" und "Dragan Kovacs" <-> "Dragan Kovács".
create or replace function public.name_key(t text) returns text
language sql immutable as $$
  select coalesce((
    select string_agg(w, ' ' order by w)
    from unnest(string_to_array(lower(regexp_replace(coalesce(t, ''), '[^a-zA-Z]', ' ', 'g')), ' ')) w
    where w <> ''
  ), '');
$$;

-- Schreibt den Fuhrpark-Spiegel. Warum eine RPC statt eines normalen Upserts:
-- der Primaerschluessel kennzeichen_key entsteht aus public.kennzeichen_key().
-- Diese Normalisierung darf es nur EINMAL geben - haette der Sync sie in
-- TypeScript nachgebaut, wuerden beide mit der Zeit auseinanderlaufen.
-- Es wird nur eingefuegt und aktualisiert, nie geloescht.
create or replace function public.fuhrpark_ersetzen(p_zeilen jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with roh as (
    select * from jsonb_to_recordset(p_zeilen) as x(
      kennzeichen text, modell text, firma text, pauschale numeric,
      pauschal_modell text, eigentuemer jsonb, vin text, kilometerstand text,
      ablauf_pickerl date, polizze text, versicherung_monatlich text,
      taxameter jsonb, bolt_werbung boolean, dashcam boolean)
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
      versicherung_monatlich, taxameter, bolt_werbung, dashcam, aktualisiert_am)
    select public.kennzeichen_key(z.kennzeichen), z.kennzeichen, z.modell, z.firma,
           z.pauschale, z.pauschal_modell,
           case when z.eigentuemer is null then null
                else array(select jsonb_array_elements_text(z.eigentuemer)) end,
           z.vin, z.kilometerstand, z.ablauf_pickerl, z.polizze, z.versicherung_monatlich,
           case when z.taxameter is null then null
                else array(select jsonb_array_elements_text(z.taxameter)) end,
           z.bolt_werbung, z.dashcam, now()
    from z
    on conflict (kennzeichen_key) do update set
      kennzeichen = excluded.kennzeichen, modell = excluded.modell,
      firma = excluded.firma, pauschale = excluded.pauschale,
      pauschal_modell = excluded.pauschal_modell, eigentuemer = excluded.eigentuemer,
      vin = excluded.vin, kilometerstand = excluded.kilometerstand,
      ablauf_pickerl = excluded.ablauf_pickerl, polizze = excluded.polizze,
      versicherung_monatlich = excluded.versicherung_monatlich,
      taxameter = excluded.taxameter, bolt_werbung = excluded.bolt_werbung,
      dashcam = excluded.dashcam, aktualisiert_am = now()
    returning 1
  )
  select count(*) into n from ein;
  return n;
end $$;

revoke all on function public.fuhrpark_ersetzen(jsonb) from public, anon, authenticated;
grant execute on function public.fuhrpark_ersetzen(jsonb) to service_role;

-- Zuordnungen nachziehen. Ruehrt NIE an bestehende Werte:
--   * fahrer.notion_fahrer_id nur, wo bisher leer
--   * bolt_/uber_drivers.fahrer_id nur, wo bisher leer
--   * 'manuell' gesetzte Zuordnungen bleiben unberuehrt
-- Mehrdeutiges wird ausgelassen, nicht geraten.
create or replace function public.notion_zuordnung_aktualisieren()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_notion int := 0; v_bolt int := 0; v_uber int := 0;
begin
  with n as (
    select notion_fahrer_id nid, public.tel_key(telefon) tel,
           public.name_key(name) nk, status
    from public.notion_fahrer where notion_fahrer_id is not null
  ),
  f as (
    select id, public.tel_key(telefon) tel, public.name_key(name) nk
    from public.fahrer where aktiv and notion_fahrer_id is null
  ),
  kandidat as (
    select f.id fahrer_id, n.nid,
           case when f.tel <> '' and f.tel = n.tel           then 1
                when f.nk = n.nk and n.status = 'Angemeldet' then 2
                when f.nk = n.nk                             then 3 end rang
    from f join n on (f.tel <> '' and f.tel = n.tel) or (f.nk <> '' and f.nk = n.nk)
  ),
  best as (
    select distinct on (fahrer_id) fahrer_id, nid
    from kandidat where rang is not null order by fahrer_id, rang, nid desc
  ),
  getan as (
    update public.fahrer f set notion_fahrer_id = b.nid
    from best b where f.id = b.fahrer_id and f.notion_fahrer_id is null returning 1
  )
  select count(*) into v_notion from getan;

  with f as (select id, public.tel_key(telefon) tel, public.name_key(name) nk
             from public.fahrer where aktiv),
  e_tel  as (select tel, min(id) fid from f where tel <> '' group by tel having count(distinct id) = 1),
  e_name as (select nk,  min(id) fid from f where nk  <> '' group by nk  having count(distinct id) = 1),
  b as (select driver_uuid, public.tel_key(phone) tel,
               public.name_key(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) nk
        from public.bolt_drivers where fahrer_id is null),
  getan as (
    update public.bolt_drivers bd
       set fahrer_id = coalesce(et.fid, en.fid),
           zuordnung_quelle = case when et.fid is not null then 'telefon' else 'name' end
    from b
    left join e_tel  et on et.tel = b.tel and b.tel <> ''
    left join e_name en on en.nk  = b.nk  and b.nk  <> ''
    where bd.driver_uuid = b.driver_uuid and bd.fahrer_id is null
      and coalesce(et.fid, en.fid) is not null
    returning 1
  )
  select count(*) into v_bolt from getan;

  with f as (select id, public.tel_key(telefon) tel, public.name_key(name) nk
             from public.fahrer where aktiv),
  e_tel  as (select tel, min(id) fid from f where tel <> '' group by tel having count(distinct id) = 1),
  e_name as (select nk,  min(id) fid from f where nk  <> '' group by nk  having count(distinct id) = 1),
  u as (select driver_uuid, public.tel_key(telefon) tel,
               public.name_key(coalesce(vorname,'') || ' ' || coalesce(nachname,'')) nk
        from public.uber_drivers where fahrer_id is null),
  getan as (
    update public.uber_drivers ud
       set fahrer_id = coalesce(et.fid, en.fid),
           zuordnung_quelle = case when et.fid is not null then 'telefon' else 'name' end
    from u
    left join e_tel  et on et.tel = u.tel and u.tel <> ''
    left join e_name en on en.nk  = u.nk  and u.nk  <> ''
    where ud.driver_uuid = u.driver_uuid and ud.fahrer_id is null
      and coalesce(et.fid, en.fid) is not null
    returning 1
  )
  select count(*) into v_uber from getan;

  return jsonb_build_object('notion_ids', v_notion, 'bolt_zuordnungen', v_bolt,
                            'uber_zuordnungen', v_uber);
end $$;

revoke all on function public.notion_zuordnung_aktualisieren() from public, anon, authenticated;
grant execute on function public.notion_zuordnung_aktualisieren() to service_role;
