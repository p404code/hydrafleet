-- ============================================================================
-- Fahrer-App (v1): Freigaben, App-Zugang, Handzuordnungen, Fahrer-RPCs,
-- Buero-RPCs, Block 0 in notion_zuordnung_aktualisieren(), plattform_konten,
-- Ampel in fahrer_uebersicht.
--
-- Vertrag: docs/2026-09-23-fahrerapp-schnittstelle.md (Abschnitt 1, Anhang A/B).
--
-- Grundsaetze:
--   * settlements, fahrer, kassier_zahlungen werden nur gelesen.
--   * Neue Tabellen: RLS an, anon ohne Rechte, keine Insert-/Update-Policy.
--     Geschrieben wird nur ueber security-definer-RPCs bzw. die Edge Function
--     fahrer-zugang (service_role).
--   * Funktionen: security definer, set search_path = public,
--     revoke from public, anon; grant execute to authenticated.
--   * Views: security_invoker = true.
--   * Wiederholbar formuliert (if not exists / drop policy if exists /
--     create or replace / on conflict do nothing).
-- ============================================================================


-- === 1.1 abrechnung_freigaben ===============================================
-- Eine Zeile je freigegebener Woche. Nur freigegebene Wochen sieht der Fahrer.
-- Zuruecknehmen = delete (Policy unten), Freigeben = rpc woche_freigeben.
create table if not exists public.abrechnung_freigaben (
  woche            text primary key,
  freigegeben_am   timestamptz not null default now(),
  freigegeben_von  text not null,
  anzahl           integer not null,
  summe            numeric not null
);
alter table public.abrechnung_freigaben enable row level security;
revoke all on public.abrechnung_freigaben from anon;
drop policy if exists app_users_read   on public.abrechnung_freigaben;
drop policy if exists app_users_delete on public.abrechnung_freigaben;
create policy app_users_read   on public.abrechnung_freigaben for select to authenticated using (public.is_app_user());
create policy app_users_delete on public.abrechnung_freigaben for delete to authenticated using (public.is_app_user());


-- === 1.2 fahrer_app_zugang ==================================================
-- Gepflegt nur von der Edge Function fahrer-zugang (service_role).
-- Schluessel ist die stabile Notion-Nr.; kein FK auf auth.users.
create table if not exists public.fahrer_app_zugang (
  notion_fahrer_id integer primary key,
  auth_user_id     uuid not null unique,
  angelegt_am      timestamptz not null default now(),
  angelegt_von     text not null,
  pin_geaendert_am timestamptz,
  gesperrt         boolean not null default false,
  gesperrt_am      timestamptz
);
alter table public.fahrer_app_zugang enable row level security;
revoke all on public.fahrer_app_zugang from anon;
drop policy if exists app_users_read on public.fahrer_app_zugang;
create policy app_users_read on public.fahrer_app_zugang for select to authenticated using (public.is_app_user());


-- === 1.3 zuordnung_manuell ==================================================
-- Handzuordnungen Plattformkonto -> Notion-Nr. Ueberleben das Loeschen und
-- Neuanlegen von fahrer durch n8n (Block 0 in notion_zuordnung_aktualisieren).
create table if not exists public.zuordnung_manuell (
  anbieter         text not null check (anbieter in ('bolt','uber')),
  driver_uuid      text not null,
  notion_fahrer_id integer not null,
  gesetzt_von      text not null,
  gesetzt_am       timestamptz not null default now(),
  primary key (anbieter, driver_uuid)
);
alter table public.zuordnung_manuell enable row level security;
revoke all on public.zuordnung_manuell from anon;
drop policy if exists app_users_read on public.zuordnung_manuell;
create policy app_users_read on public.zuordnung_manuell for select to authenticated using (public.is_app_user());

-- Nachtrag: bestehende Handzuordnung (Konto steht auf fahrer 637
-- "Muhammet Usta", Nr. 282, zuordnung_quelle = 'manuell').
insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von)
values ('bolt', '9877577f-d44a-4c3c-8114-4c701e38547f', 282, 'Migration')
on conflict do nothing;


-- === 1.4 Fahrer-Funktionen ==================================================
-- Anker: app_metadata.fahrer_nr = fahrer.notion_fahrer_id, nur aktive Fahrer,
-- genau ein Treffer, UND auth.uid() steht ungesperrt in fahrer_app_zugang.
create or replace function public.mein_fahrer_id() returns integer
language sql stable security definer set search_path = public as $$
  select min(f.id)
  from public.fahrer f
  join public.fahrer_app_zugang z
    on z.notion_fahrer_id = f.notion_fahrer_id
   and z.auth_user_id = auth.uid()
   and not z.gesperrt
  where f.aktiv
    and coalesce(auth.jwt()->'app_metadata'->>'fahrer_nr', '') ~ '^[0-9]{1,9}$'
    and f.notion_fahrer_id = (auth.jwt()->'app_metadata'->>'fahrer_nr')::integer
  having count(*) = 1
$$;

-- Wer wird angezeigt: Fahrer -> immer der eigene (Parameter ignoriert);
-- Buero ohne Parameter -> null (leer); Buero mit Parameter -> Vorschau.
create or replace function public.fahrer_app_ziel(p_fahrer_id integer) returns integer
language sql stable security definer set search_path = public as $$
  select case
    when p_fahrer_id is not null and public.is_app_user()
      then (select f.id from public.fahrer f where f.id = p_fahrer_id)
    when public.is_app_user() then null
    else public.mein_fahrer_id()
  end
$$;

create or replace function public.fahrer_app_profil(p_fahrer_id integer default null)
returns table (
  fahrer_id integer, fahrer_nr integer, name text, kennzeichen text, mietmodell text,
  fahrzeug_modell text, vorschau boolean, nr_eindeutig boolean, app_zugang text
)
language sql stable security definer set search_path = public as $$
  select f.id, f.notion_fahrer_id, f.name, f.kennzeichen, f.mietmodell,
         fp.modell,
         (p_fahrer_id is not null and public.is_app_user()),
         (f.notion_fahrer_id is not null
          and (select count(*) from public.fahrer x where x.aktiv and x.notion_fahrer_id = f.notion_fahrer_id) = 1),
         case when z.notion_fahrer_id is null then 'kein_zugang'
              when z.gesperrt then 'gesperrt' else 'aktiv' end
  from public.fahrer f
  left join public.fuhrpark fp
    on fp.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen,'') <> ''
  left join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id)
$$;

-- Felder des Druckzettels; nur die 3 neuesten Freigaben (woche desc als Text).
create or replace function public.fahrer_app_abrechnungen(p_fahrer_id integer default null)
returns table (
  woche text, freigegeben_am timestamptz, mietmodell text,
  bolt_brutto numeric, uber_fahrpreis numeric, mypos_summe numeric, bruttoumsatz_gesamt numeric,
  bolt_auszahlung numeric, uber_auszahlung numeric, wir_bekommen numeric,
  miete numeric, prozent_abzug numeric, abzug_gesamt numeric,
  korrektur numeric, korrektur_note text, lohn numeric, auszahlung numeric, du_bekommst numeric
)
language sql stable security definer set search_path = public as $$
  with ziel as (select public.fahrer_app_ziel(p_fahrer_id) as id),
  wochen as (
    select fr.woche, fr.freigegeben_am from public.abrechnung_freigaben fr
    order by fr.woche desc limit 3
  )
  select s.woche, w.freigegeben_am, s.mietmodell,
         s.bolt_brutto, s.uber_fahrpreis, s.mypos_summe, s.bruttoumsatz_gesamt,
         s.bolt_auszahlung, s.uber_auszahlung, s.wir_bekommen,
         s.miete, s.prozent_abzug, s.abzug_gesamt,
         s.korrektur, s.korrektur_note, s.lohn, s.auszahlung,
         coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)
  from wochen w
  join public.settlements s on s.woche = w.woche
  cross join ziel
  where ziel.id is not null
    and s.status = 'berechnet'
    and s.fahrer_name not like '\_\_%'
    and public.settlement_fahrer(s.telefon, s.fahrer_name) = ziel.id
  order by s.woche desc, s.id
$$;

-- Offene Betraege wie getOpenDebts() (Lohn geht nicht ein), ueber alle
-- freigegebenen Wochen. Zahlungen ohne note, kassiert_von, id.
create or replace function public.fahrer_app_offen(p_fahrer_id integer default null)
returns table (woche text, freigegeben_am timestamptz, schuld numeric, kassiert numeric, offen numeric,
               status text, zahlungen jsonb)
language sql stable security definer set search_path = public as $$
  with ziel as (select public.fahrer_app_ziel(p_fahrer_id) as id),
  zeilen as (
    select s.woche, fr.freigegeben_am, s.fahrer_name, abs(s.auszahlung) as schuld
    from public.settlements s
    join public.abrechnung_freigaben fr on fr.woche = s.woche
    cross join ziel
    where ziel.id is not null
      and s.status = 'berechnet'
      and s.fahrer_name not like '\_\_%'
      and s.auszahlung < 0
      and public.settlement_fahrer(s.telefon, s.fahrer_name) = ziel.id
  ),
  mit as (
    select z.woche, z.freigegeben_am, z.schuld,
           coalesce((select sum(k.betrag) from public.kassier_zahlungen k
                     where k.fahrer_name = z.fahrer_name and k.woche = z.woche), 0) as kassiert,
           coalesce((select jsonb_agg(jsonb_build_object('datum', k.kassiert_at, 'art', k.typ, 'betrag', k.betrag)
                                      order by k.kassiert_at)
                     from public.kassier_zahlungen k
                     where k.fahrer_name = z.fahrer_name and k.woche = z.woche), '[]'::jsonb) as zahlungen
    from zeilen z
  )
  select woche, freigegeben_am, round(schuld, 2), round(kassiert, 2),
         round(greatest(schuld - kassiert, 0), 2),
         case when kassiert <= 0 then 'offen' else 'teilweise' end,
         zahlungen
  from mit
  where schuld - kassiert > 0
  order by woche desc
$$;


-- === 1.5 Buero-RPCs =========================================================
create or replace function public.woche_freigeben(p_woche text) returns public.abrechnung_freigaben
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_freigaben;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  -- Untergrenze KW37: davor liegen die Bolt-Wochenverschiebung (KW32-36) und
  -- Altschulden aus der Zeit vor KW27. Ein Fehlklick darf die nie sichtbar machen.
  -- Textvergleich reicht, weil das Format fest ist ('2026-W37k' > '2026-W37').
  if coalesce(p_woche, '') !~ '^\d{4}-W\d{2}k?$' then
    raise exception 'Ungültige Woche: %', p_woche using errcode = '22023';
  end if;
  if p_woche < '2026-W37' then
    raise exception 'Wochen vor KW37 werden nicht freigegeben (%)', p_woche using errcode = '22023';
  end if;
  insert into public.abrechnung_freigaben (woche, freigegeben_von, anzahl, summe)
  select p_woche, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'),
         count(*), round(coalesce(sum(auszahlung - coalesce(lohn,0)), 0), 2)
  from public.settlements where woche = p_woche and status = 'berechnet'
  having count(*) > 0
  on conflict (woche) do update set freigegeben_am = now(), freigegeben_von = excluded.freigegeben_von,
                                   anzahl = excluded.anzahl, summe = excluded.summe
  returning * into r;
  if r.woche is null then raise exception 'Keine berechneten Zeilen für %', p_woche using errcode = 'P0002'; end if;
  return r;
end $$;

-- E6: jeder is_app_user(). Nur-Admin: is_app_user() -> is_app_admin() in der
-- mit "-- E6" markierten Zeile.
create or replace function public.konto_zuordnen(p_anbieter text, p_driver_uuid text, p_fahrer_id integer)
returns void
language plpgsql security definer set search_path = public as $$
declare v_nid integer; v_n integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;  -- E6
  if p_anbieter not in ('bolt','uber') then raise exception 'Unbekannter Anbieter %', p_anbieter using errcode = '22023'; end if;
  select f.notion_fahrer_id into v_nid from public.fahrer f where f.id = p_fahrer_id and f.aktiv;
  if v_nid is null then raise exception 'Fahrer % nicht gefunden oder ohne Notion-Nr.', p_fahrer_id using errcode = 'P0002'; end if;
  select count(*) into v_n from public.fahrer f where f.aktiv and f.notion_fahrer_id = v_nid;
  if v_n <> 1 then raise exception 'Notion-Nr. % ist doppelt vergeben', v_nid using errcode = 'P0001'; end if;
  if p_anbieter = 'bolt' then
    update public.bolt_drivers set fahrer_id = p_fahrer_id, zuordnung_quelle = 'manuell' where driver_uuid = p_driver_uuid;
  else
    update public.uber_drivers set fahrer_id = p_fahrer_id, zuordnung_quelle = 'manuell' where driver_uuid = p_driver_uuid;
  end if;
  if not found then raise exception 'Konto % nicht gefunden', p_driver_uuid using errcode = 'P0002'; end if;
  insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von)
  values (p_anbieter, p_driver_uuid, v_nid, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  on conflict (anbieter, driver_uuid) do update
    set notion_fahrer_id = excluded.notion_fahrer_id, gesetzt_von = excluded.gesetzt_von, gesetzt_am = now();
end $$;

-- Loest nur Handzuordnungen; automatische bleiben unberuehrt.
create or replace function public.konto_loesen(p_anbieter text, p_driver_uuid text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_weg integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;  -- E6
  if p_anbieter not in ('bolt','uber') then raise exception 'Unbekannter Anbieter %', p_anbieter using errcode = '22023'; end if;
  delete from public.zuordnung_manuell where anbieter = p_anbieter and driver_uuid = p_driver_uuid;
  get diagnostics v_weg = row_count;
  if p_anbieter = 'bolt' then
    update public.bolt_drivers set fahrer_id = null, zuordnung_quelle = null
    where driver_uuid = p_driver_uuid and zuordnung_quelle = 'manuell';
  else
    update public.uber_drivers set fahrer_id = null, zuordnung_quelle = null
    where driver_uuid = p_driver_uuid and zuordnung_quelle = 'manuell';
  end if;
  return v_weg > 0 or found;
end $$;

revoke all on function public.mein_fahrer_id(), public.fahrer_app_ziel(integer),
  public.fahrer_app_profil(integer), public.fahrer_app_abrechnungen(integer), public.fahrer_app_offen(integer),
  public.woche_freigeben(text), public.konto_zuordnen(text, text, integer), public.konto_loesen(text, text)
  from public, anon;
grant execute on function public.mein_fahrer_id(), public.fahrer_app_ziel(integer),
  public.fahrer_app_profil(integer), public.fahrer_app_abrechnungen(integer), public.fahrer_app_offen(integer),
  public.woche_freigeben(text), public.konto_zuordnen(text, text, integer), public.konto_loesen(text, text)
  to authenticated;


-- === 1.6 notion_zuordnung_aktualisieren(): neuer Block 0 ====================
-- Text wie in der DB (pg_get_functiondef, 23.09.) bzw.
-- migrations/2026-09-22-notion-sync.sql; neu nur v_manuell, Block 0 und der
-- Schluessel 'manuell' in der Rueckgabe.
create or replace function public.notion_zuordnung_aktualisieren()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_notion int := 0; v_bolt int := 0; v_uber int := 0; v_manuell int := 0;
begin
  -- 0) Handzuordnungen wieder anwenden, bevor der Auto-Matcher die null-Zeilen sieht
  with ziel as (
    select z.anbieter, z.driver_uuid, min(f.id) as fahrer_id
    from public.zuordnung_manuell z
    join public.fahrer f on f.notion_fahrer_id = z.notion_fahrer_id and f.aktiv
    group by z.anbieter, z.driver_uuid having count(f.id) = 1   -- doppelte Notion-Nr.: nichts tun
  ),
  b as (
    update public.bolt_drivers bd set fahrer_id = ziel.fahrer_id, zuordnung_quelle = 'manuell'
    from ziel where ziel.anbieter = 'bolt' and bd.driver_uuid = ziel.driver_uuid
      and (bd.fahrer_id is distinct from ziel.fahrer_id or bd.zuordnung_quelle is distinct from 'manuell')
    returning 1
  ),
  u as (
    update public.uber_drivers ud set fahrer_id = ziel.fahrer_id, zuordnung_quelle = 'manuell'
    from ziel where ziel.anbieter = 'uber' and ud.driver_uuid = ziel.driver_uuid
      and (ud.fahrer_id is distinct from ziel.fahrer_id or ud.zuordnung_quelle is distinct from 'manuell')
    returning 1
  )
  select (select count(*) from b) + (select count(*) from u) into v_manuell;

  -- 1) Notion-Fahrernummer setzen: Telefon schlaegt Name, 'Angemeldet' schlaegt Karteileiche
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
           case when f.tel <> '' and f.tel = n.tel                    then 1
                when f.nk = n.nk and n.status = 'Angemeldet'          then 2
                when f.nk = n.nk                                      then 3 end rang
    from f join n on (f.tel <> '' and f.tel = n.tel) or (f.nk <> '' and f.nk = n.nk)
  ),
  best as (
    select distinct on (fahrer_id) fahrer_id, nid
    from kandidat where rang is not null order by fahrer_id, rang, nid desc
  ),
  getan as (
    update public.fahrer f set notion_fahrer_id = b.nid
    from best b where f.id = b.fahrer_id and f.notion_fahrer_id is null
    returning 1
  )
  select count(*) into v_notion from getan;

  -- 2) Bolt-Konten zuordnen: Telefon, dann exakter Name
  with f as (select id, public.tel_key(telefon) tel, public.name_key(name) nk
             from public.fahrer where aktiv),
  e_tel  as (select tel, min(id) fid from f where tel <> '' group by tel having count(distinct id) = 1),
  e_name as (select nk,  min(id) fid from f where nk  <> '' group by nk  having count(distinct id) = 1),
  b as (
    select driver_uuid, public.tel_key(phone) tel,
           public.name_key(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) nk
    from public.bolt_drivers where fahrer_id is null
  ),
  getan as (
    update public.bolt_drivers bd
       set fahrer_id = coalesce(et.fid, en.fid),
           zuordnung_quelle = case when et.fid is not null then 'telefon' else 'name' end
    from b
    left join e_tel  et on et.tel = b.tel and b.tel <> ''
    left join e_name en on en.nk  = b.nk  and b.nk  <> ''
    where bd.driver_uuid = b.driver_uuid
      and bd.fahrer_id is null
      and coalesce(et.fid, en.fid) is not null
    returning 1
  )
  select count(*) into v_bolt from getan;

  -- 3) Uber-Konten, gleiche Regel
  with f as (select id, public.tel_key(telefon) tel, public.name_key(name) nk
             from public.fahrer where aktiv),
  e_tel  as (select tel, min(id) fid from f where tel <> '' group by tel having count(distinct id) = 1),
  e_name as (select nk,  min(id) fid from f where nk  <> '' group by nk  having count(distinct id) = 1),
  u as (
    select driver_uuid, public.tel_key(telefon) tel,
           public.name_key(coalesce(vorname,'') || ' ' || coalesce(nachname,'')) nk
    from public.uber_drivers where fahrer_id is null
  ),
  getan as (
    update public.uber_drivers ud
       set fahrer_id = coalesce(et.fid, en.fid),
           zuordnung_quelle = case when et.fid is not null then 'telefon' else 'name' end
    from u
    left join e_tel  et on et.tel = u.tel and u.tel <> ''
    left join e_name en on en.nk  = u.nk  and u.nk  <> ''
    where ud.driver_uuid = u.driver_uuid
      and ud.fahrer_id is null
      and coalesce(et.fid, en.fid) is not null
    returning 1
  )
  select count(*) into v_uber from getan;

  return jsonb_build_object('notion_ids', v_notion, 'bolt_zuordnungen', v_bolt,
                            'uber_zuordnungen', v_uber, 'manuell', v_manuell);
end $$;

revoke all on function public.notion_zuordnung_aktualisieren() from public, anon, authenticated;
grant execute on function public.notion_zuordnung_aktualisieren() to service_role;


-- === 1.7 View plattform_konten ==============================================
-- Eine Zeile je Plattformkonto. Vorschlag nur fuer Konten ohne Fahrer:
-- eindeutiger name_key-Treffer, sonst cent-genauer Betrag in der letzten Woche.
create or replace view public.plattform_konten with (security_invoker = true) as
with f_aktiv as (select id, name, notion_fahrer_id, public.name_key(name) nk from public.fahrer where aktiv),
e_name as (select nk, min(id) fid from f_aktiv where nk <> '' group by nk having count(*) = 1),
bw as (select max(woche) w from public.bolt_orders),
uw as (select max(woche) w from public.uber_reports where umsaetze is not null),
b_umsatz as (
  select o.driver_uuid, round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2) u
  from public.bolt_orders o, bw where o.woche = bw.w group by o.driver_uuid
),
b_fahrten as (
  select driver_uuid, count(*)::integer n from public.bolt_orders
  where order_status = 'finished' and order_finished_at > now() - interval '30 days' group by driver_uuid
),
u_umsatz as (
  select r.driver_uuid, round(sum(coalesce(r.fahrpreis,0)), 2) u
  from public.uber_reports r, uw where r.woche = uw.w and r.umsaetze is not null group by r.driver_uuid
),
u_fahrten as (
  select driver_uuid, count(*)::integer n from public.uber_trips
  where status = 'completed' and bestellt_am > (now() at time zone 'Europe/Vienna') - interval '30 days'
  group by driver_uuid
),
konten as (
  select 'bolt'::text anbieter, bd.driver_uuid,
         trim(coalesce(bd.first_name,'') || ' ' || coalesce(bd.last_name,'')) konto_name,
         bd.phone telefon, v.firma, bd.state, bd.fahrer_id, bd.zuordnung_quelle,
         coalesce(bu.u, 0) umsatz_letzte_woche, coalesce(bf.n, 0) fahrten_30t
  from public.bolt_drivers bd
  left join public.verbindungen v on v.anbieter = 'bolt' and v.externe_id = bd.company_id::text
  left join b_umsatz bu on bu.driver_uuid = bd.driver_uuid
  left join b_fahrten bf on bf.driver_uuid = bd.driver_uuid
  union all
  select 'uber', ud.driver_uuid,
         trim(coalesce(ud.vorname,'') || ' ' || coalesce(ud.nachname,'')),
         ud.telefon, v.firma, null::text, ud.fahrer_id, ud.zuordnung_quelle,
         coalesce(uu.u, 0), coalesce(uf.n, 0)
  from public.uber_drivers ud
  left join public.verbindungen v on v.anbieter = 'uber' and v.externe_id = ud.org_id
  left join u_umsatz uu on uu.driver_uuid = ud.driver_uuid
  left join u_fahrten uf on uf.driver_uuid = ud.driver_uuid
)
select k.anbieter, k.driver_uuid, k.konto_name, k.telefon, k.firma, k.state,
       k.fahrer_id, f.name as fahrer_name, f.notion_fahrer_id, k.zuordnung_quelle,
       zm.gesetzt_am as manuell_seit, zm.gesetzt_von as manuell_von,
       k.umsatz_letzte_woche, k.fahrten_30t,
       case when k.fahrer_id is null then coalesce(en.fid, bt.fid) end as vorschlag_fahrer_id,
       case when k.fahrer_id is null then case when en.fid is not null then 'name'
                                               when bt.fid is not null then 'betrag' end end as vorschlag_grund
from konten k
left join public.fahrer f on f.id = k.fahrer_id
left join public.zuordnung_manuell zm on zm.anbieter = k.anbieter and zm.driver_uuid = k.driver_uuid
left join e_name en on en.nk = public.name_key(k.konto_name) and en.nk <> ''
left join lateral (
  select min(public.settlement_fahrer(s.telefon, s.fahrer_name)) fid
  from public.settlements s
  where k.fahrer_id is null and k.umsatz_letzte_woche <> 0 and s.status = 'berechnet'
    and s.woche = case k.anbieter when 'bolt' then (select w from bw) else (select w from uw) end
    and round(case k.anbieter when 'bolt' then s.bolt_brutto else s.uber_fahrpreis end, 2) = k.umsatz_letzte_woche
  having count(*) = 1
) bt on true;
revoke all on public.plattform_konten from anon;
grant select on public.plattform_konten to authenticated;


-- === 1.8 fahrer_uebersicht: App-Ampel =======================================
-- Text wie migrations/2026-09-22-bolt-sync-ergaenzungen.sql (= DB-Stand).
-- Neu: CTE zugang + Join, zwei probleme-Eintraege vor "Kennzeichen nicht bei
-- Bolt", vier Spalten hinten angehaengt (sonst verweigert Postgres das Replace).
create or replace view public.fahrer_uebersicht with (security_invoker = true) as
with kfz as (
  select regexp_replace(upper(coalesce(reg_number,'')), '[^A-Z0-9]', '', 'g') as kz,
         min(model) as modell, min(year) as baujahr, min(color) as farbe,
         min(state) as fahrzeug_status
  from public.bolt_vehicles
  where reg_number is not null and reg_number <> ''
  group by 1
),
letzte as (
  select distinct on (fahrer_name) fahrer_name, woche, auszahlung
  from public.settlements where fahrer_name not like '\_\_%'
  order by fahrer_name, woche desc
),
schuld as (
  select s.fahrer_name,
         round(sum(greatest(abs(s.auszahlung) - coalesce(k.bezahlt, 0), 0)), 2) as offen
  from public.settlements s
  left join (select fahrer_name, woche, sum(betrag) as bezahlt
               from public.kassier_zahlungen group by 1, 2) k
         on k.fahrer_name = s.fahrer_name and k.woche = s.woche
  where s.auszahlung < 0 and s.fahrer_name not like '\_\_%'
  group by 1
),
bolt as (
  select fahrer_id, count(*)::int as konten,
         count(*) filter (where state = 'active')::int as konten_aktiv,
         max(driver_rating) as bewertung
  from public.bolt_drivers where fahrer_id is not null group by 1
),
fahrten as (
  select bd.fahrer_id, count(*)::int as fahrten_30t
  from public.bolt_orders o
  join public.bolt_drivers bd on bd.driver_uuid = o.driver_uuid
  where bd.fahrer_id is not null and o.order_status = 'finished'
    and o.order_finished_at > now() - interval '30 days'
  group by 1
),
doppelt as (
  select notion_fahrer_id from public.fahrer
  where notion_fahrer_id is not null group by 1 having count(*) > 1
),
zugang as (
  select notion_fahrer_id, gesperrt, angelegt_am from public.fahrer_app_zugang
)
select
  f.id as fahrer_id, f.notion_fahrer_id, f.name, f.telefon, f.kennzeichen, f.aktiv, f.mietmodell,
  split_part(kfz.modell, ' ', 1) as marke,
  nullif(trim(substr(kfz.modell, length(split_part(kfz.modell,' ',1)) + 1)), '') as modell,
  kfz.baujahr, kfz.farbe, kfz.fahrzeug_status,
  coalesce(b.konten, 0) as bolt_konten, coalesce(b.konten_aktiv, 0) as bolt_konten_aktiv,
  b.bewertung as bolt_bewertung,
  coalesce(fa.fahrten_30t, 0) as fahrten_30t,
  l.woche as letzte_woche, l.auszahlung as letzte_auszahlung,
  coalesce(sch.offen, 0) as offen,
  array_remove(array[
    case when coalesce(f.telefon,'') = ''     then 'keine Telefonnummer' end,
    case when coalesce(f.kennzeichen,'') = '' then 'kein Kennzeichen' end,
    case when f.notion_fahrer_id is null      then 'keine Notion-ID' end,
    case when coalesce(b.konten, 0) = 0       then 'kein Bolt-Konto' end,
    case when d.notion_fahrer_id is not null  then 'Notion-ID doppelt vergeben' end,
    case when f.notion_fahrer_id is not null and d.notion_fahrer_id is null
              and za.notion_fahrer_id is null then 'kein App-Zugang' end,
    case when za.gesperrt                     then 'App-Zugang gesperrt' end,
    case when coalesce(f.kennzeichen,'') <> '' and kfz.kz is null
                                              then 'Kennzeichen nicht bei Bolt' end
  ], null) as probleme,
  -- App-Ampel (neu, hinten angehaengt)
  (f.aktiv and f.notion_fahrer_id is not null and d.notion_fahrer_id is null) as app_faehig,
  case when za.notion_fahrer_id is null then 'kein_zugang'
       when za.gesperrt then 'gesperrt' else 'aktiv' end as app_zugang,
  za.angelegt_am as app_zugang_seit,
  (f.aktiv and f.notion_fahrer_id is not null and d.notion_fahrer_id is null
   and za.notion_fahrer_id is not null and not za.gesperrt) as app_bereit
from public.fahrer f
left join kfz on kfz.kz = regexp_replace(upper(coalesce(f.kennzeichen,'')), '[^A-Z0-9]', '', 'g')
              and coalesce(f.kennzeichen,'') <> ''
left join letzte l   on l.fahrer_name = f.name
left join schuld sch on sch.fahrer_name = f.name
left join bolt b     on b.fahrer_id = f.id
left join fahrten fa on fa.fahrer_id = f.id
left join doppelt d  on d.notion_fahrer_id = f.notion_fahrer_id
left join zugang za  on za.notion_fahrer_id = f.notion_fahrer_id;

grant select on public.fahrer_uebersicht to authenticated;
