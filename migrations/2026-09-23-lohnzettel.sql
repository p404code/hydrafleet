-- ============================================================================
-- Lohnzettel: Upload je Firma+Monat (AJ + LZ), PDF je Person, Zuordnung ueber
-- Firma + Personalnummer, Anzeige in der Fahrerapp, Dienstgeber aus companies.
-- Spec: docs/superpowers/specs/2026-09-23-lohnzettel-design.md
--
-- * settlements, fahrer, companies werden nur gelesen.
-- * Keine SV-Nummer, keine Adresse der Person in Tabellen - nur im PDF.
-- * Schreiben nur ueber RPCs (security definer, is_app_user()).
-- ============================================================================

-- === Tabellen ================================================================
create table if not exists public.lohn_laeufe (
  id                  uuid primary key default gen_random_uuid(),
  firma_nr            text not null,
  firma_name          text not null,
  monat               date not null check (extract(day from monat) = 1),
  journal_datum       date,
  anzahl_dienstnehmer integer not null,
  summe_dienstnehmer  numeric not null,
  koerperschaften     jsonb not null default '[]'::jsonb,
  gesamt_summe        numeric,
  aj_pfad             text not null,
  hochgeladen_von     text not null,
  hochgeladen_am      timestamptz not null default now(),
  unique (firma_nr, monat)
);

create table if not exists public.lohn_zettel (
  id             uuid primary key default gen_random_uuid(),
  lauf_id        uuid not null references public.lohn_laeufe(id) on delete cascade,
  ma_nr          integer not null,
  name           text not null,
  seiten         integer not null default 1,
  brutto         numeric,
  netto          numeric,
  auszahlung     numeric not null,
  journal_betrag numeric,
  pfad           text not null unique,
  unique (lauf_id, ma_nr)
);

create table if not exists public.lohn_personen (
  firma_nr         text not null,
  ma_nr            integer not null,
  notion_fahrer_id integer not null,
  gesetzt_von      text not null,
  gesetzt_am       timestamptz not null default now(),
  primary key (firma_nr, ma_nr)
);

alter table public.lohn_laeufe   enable row level security;
alter table public.lohn_zettel   enable row level security;
alter table public.lohn_personen enable row level security;
revoke all on public.lohn_laeufe, public.lohn_zettel, public.lohn_personen from anon;
drop policy if exists app_users_read on public.lohn_laeufe;
drop policy if exists app_users_read on public.lohn_zettel;
drop policy if exists app_users_read on public.lohn_personen;
create policy app_users_read on public.lohn_laeufe   for select to authenticated using (public.is_app_user());
create policy app_users_read on public.lohn_zettel   for select to authenticated using (public.is_app_user());
create policy app_users_read on public.lohn_personen for select to authenticated using (public.is_app_user());


-- === Zuordnung Zettel -> Fahrer (aktiv, Notion-Nr. eindeutig) =================
create or replace function public.lohn_zettel_fahrer(p_firma_nr text, p_ma_nr integer)
returns integer language sql stable security definer set search_path = public as $$
  select min(f.id) from public.lohn_personen p
  join public.fahrer f on f.notion_fahrer_id = p.notion_fahrer_id and f.aktiv
  where p.firma_nr = p_firma_nr and p.ma_nr = p_ma_nr
  having count(*) = 1
$$;


-- === Upload speichern ========================================================
-- p_lauf: {firma_nr, firma_name, monat 'YYYY-MM-01', journal_datum, anzahl_dienstnehmer,
--          summe_dienstnehmer, koerperschaften [], gesamt_summe, aj_pfad,
--          zettel: [{ma_nr, name, seiten, brutto, netto, auszahlung, journal_betrag, pfad}]}
-- Gibt die Pfade alter Zettel zurueck, die im neuen Stand fehlen (Client loescht sie).
create or replace function public.lohn_lauf_speichern(p_lauf jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_alt text[]; v_n integer; v_summe numeric;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if coalesce(p_lauf->>'firma_nr','') = '' or coalesce(p_lauf->>'monat','') = ''
     or jsonb_typeof(p_lauf->'zettel') <> 'array' then
    raise exception 'Unvollständige Daten' using errcode = '22023';
  end if;
  select count(*), coalesce(sum((z->>'auszahlung')::numeric), 0)
    into v_n, v_summe from jsonb_array_elements(p_lauf->'zettel') z;
  if v_n <> (p_lauf->>'anzahl_dienstnehmer')::integer then
    raise exception 'Anzahl passt nicht: % Zettel, Journal %', v_n, p_lauf->>'anzahl_dienstnehmer' using errcode = '22023';
  end if;
  if abs(v_summe - (p_lauf->>'summe_dienstnehmer')::numeric) > 0.05 then
    raise exception 'Summe passt nicht: Zettel %, Journal %', v_summe, p_lauf->>'summe_dienstnehmer' using errcode = '22023';
  end if;

  select array_agg(z.pfad) into v_alt
  from public.lohn_zettel z join public.lohn_laeufe l on l.id = z.lauf_id
  where l.firma_nr = p_lauf->>'firma_nr' and l.monat = (p_lauf->>'monat')::date
    and z.pfad not in (select x->>'pfad' from jsonb_array_elements(p_lauf->'zettel') x);

  delete from public.lohn_laeufe where firma_nr = p_lauf->>'firma_nr' and monat = (p_lauf->>'monat')::date;

  insert into public.lohn_laeufe (firma_nr, firma_name, monat, journal_datum, anzahl_dienstnehmer,
         summe_dienstnehmer, koerperschaften, gesamt_summe, aj_pfad, hochgeladen_von)
  values (p_lauf->>'firma_nr', p_lauf->>'firma_name', (p_lauf->>'monat')::date,
          nullif(p_lauf->>'journal_datum','')::date, (p_lauf->>'anzahl_dienstnehmer')::integer,
          (p_lauf->>'summe_dienstnehmer')::numeric, coalesce(p_lauf->'koerperschaften','[]'::jsonb),
          nullif(p_lauf->>'gesamt_summe','')::numeric, p_lauf->>'aj_pfad',
          coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  returning id into v_id;

  insert into public.lohn_zettel (lauf_id, ma_nr, name, seiten, brutto, netto, auszahlung, journal_betrag, pfad)
  select v_id, (z->>'ma_nr')::integer, z->>'name', coalesce((z->>'seiten')::integer, 1),
         nullif(z->>'brutto','')::numeric, nullif(z->>'netto','')::numeric,
         (z->>'auszahlung')::numeric, nullif(z->>'journal_betrag','')::numeric, z->>'pfad'
  from jsonb_array_elements(p_lauf->'zettel') z;

  return jsonb_build_object('lauf_id', v_id, 'zettel', v_n, 'alte_pfade', coalesce(to_jsonb(v_alt), '[]'::jsonb));
end $$;

-- p_fahrer_id null = Zuordnung loeschen
create or replace function public.lohn_person_zuordnen(p_firma_nr text, p_ma_nr integer, p_fahrer_id integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_nid integer; v_n integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_fahrer_id is null then
    delete from public.lohn_personen where firma_nr = p_firma_nr and ma_nr = p_ma_nr;
    return;
  end if;
  select f.notion_fahrer_id into v_nid from public.fahrer f where f.id = p_fahrer_id and f.aktiv;
  if v_nid is null then raise exception 'Fahrer % nicht gefunden oder ohne Notion-Nr.', p_fahrer_id using errcode = 'P0002'; end if;
  select count(*) into v_n from public.fahrer f where f.aktiv and f.notion_fahrer_id = v_nid;
  if v_n <> 1 then raise exception 'Notion-Nr. % ist doppelt vergeben', v_nid using errcode = 'P0001'; end if;
  insert into public.lohn_personen (firma_nr, ma_nr, notion_fahrer_id, gesetzt_von)
  values (p_firma_nr, p_ma_nr, v_nid, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  on conflict (firma_nr, ma_nr) do update
    set notion_fahrer_id = excluded.notion_fahrer_id, gesetzt_von = excluded.gesetzt_von, gesetzt_am = now();
end $$;


-- === Uebersicht fuers Buero (mit Zuordnungs-Vorschlag) =======================
create or replace view public.lohn_zettel_uebersicht with (security_invoker = true) as
with f_aktiv as (
  select id, name, public.name_key(name) nk,
         public.name_key(regexp_replace(name, '^.*\s', '')) nachname_k
  from public.fahrer where aktiv
),
e_voll as (select nk, min(id) fid from f_aktiv group by nk having count(*) = 1),
e_nach as (select nachname_k, min(id) fid from f_aktiv group by nachname_k having count(*) = 1),
z as (
  select z.*, l.firma_nr, l.firma_name, l.monat,
         trim(split_part(z.name, ',', 1)) nachname, trim(split_part(z.name, ',', 2)) vorname
  from public.lohn_zettel z join public.lohn_laeufe l on l.id = z.lauf_id
)
select z.id, z.lauf_id, z.firma_nr, z.firma_name, z.monat, z.ma_nr, z.name, z.seiten,
       z.brutto, z.netto, z.auszahlung, z.journal_betrag, z.pfad,
       public.lohn_zettel_fahrer(z.firma_nr, z.ma_nr) as fahrer_id,
       f.name as fahrer_name, f.notion_fahrer_id,
       p.gesetzt_von as zugeordnet_von, p.gesetzt_am as zugeordnet_am,
       case when p.ma_nr is null then coalesce(ev.fid, en.fid) end as vorschlag_fahrer_id
from z
left join public.lohn_personen p on p.firma_nr = z.firma_nr and p.ma_nr = z.ma_nr
left join public.fahrer f on f.id = public.lohn_zettel_fahrer(z.firma_nr, z.ma_nr)
left join e_voll ev on ev.nk = public.name_key(z.vorname || ' ' || z.nachname)
left join e_nach en on en.nachname_k = public.name_key(z.nachname);
revoke all on public.lohn_zettel_uebersicht from anon;
grant select on public.lohn_zettel_uebersicht to authenticated;

-- Laeufe mit Adresse aus companies (nur lesen)
create or replace view public.lohn_laeufe_uebersicht with (security_invoker = true) as
select l.id, l.firma_nr, l.firma_name, l.monat, l.journal_datum, l.anzahl_dienstnehmer,
       l.summe_dienstnehmer, l.koerperschaften, l.gesamt_summe, l.aj_pfad,
       l.hochgeladen_von, l.hochgeladen_am,
       c.address as firma_adresse,
       (select count(*) from public.lohn_zettel z
         where z.lauf_id = l.id and public.lohn_zettel_fahrer(l.firma_nr, z.ma_nr) is null)::integer as ohne_fahrer
from public.lohn_laeufe l
left join public.companies c on c.name = l.firma_name;
revoke all on public.lohn_laeufe_uebersicht from anon;
grant select on public.lohn_laeufe_uebersicht to authenticated;

-- Neuester Lohnzettel je Fahrer und Firma (Hinweis beim Lohn-Feld)
create or replace view public.lohn_letzte with (security_invoker = true) as
select distinct on (u.fahrer_id, u.firma_nr)
       u.fahrer_id, u.fahrer_name, f.telefon, u.firma_nr, u.firma_name, u.monat, u.auszahlung
from public.lohn_zettel_uebersicht u
join public.fahrer f on f.id = u.fahrer_id
where u.fahrer_id is not null
order by u.fahrer_id, u.firma_nr, u.monat desc;
revoke all on public.lohn_letzte from anon;
grant select on public.lohn_letzte to authenticated;


-- === Fahrerapp ===============================================================
create or replace function public.fahrer_app_lohnzettel(p_fahrer_id integer default null)
returns table (monat date, firma_name text, auszahlung numeric, pfad text)
language sql stable security definer set search_path = public as $$
  select l.monat, l.firma_name, z.auszahlung, z.pfad
  from public.lohn_zettel z
  join public.lohn_laeufe l on l.id = z.lauf_id
  where public.lohn_zettel_fahrer(l.firma_nr, z.ma_nr) = public.fahrer_app_ziel(p_fahrer_id)
  order by l.monat desc, l.firma_name
$$;

-- Firma(en) des neuesten Lohnzettel-Monats, Adresse aus companies
create or replace function public.fahrer_app_dienstgeber(p_fahrer_id integer default null)
returns table (firma_name text, adresse text, monat date)
language sql stable security definer set search_path = public as $$
  with meine as (
    select l.firma_name, l.monat
    from public.lohn_zettel z join public.lohn_laeufe l on l.id = z.lauf_id
    where public.lohn_zettel_fahrer(l.firma_nr, z.ma_nr) = public.fahrer_app_ziel(p_fahrer_id)
  )
  select distinct m.firma_name, c.address, m.monat
  from meine m
  left join public.companies c on c.name = m.firma_name
  where m.monat = (select max(monat) from meine)
  order by m.firma_name
$$;

-- Storage: darf der angemeldete Fahrer diesen Pfad lesen?
create or replace function public.lohn_pfad_erlaubt(p_pfad text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_app_user() or exists (
    select 1 from public.lohn_zettel z join public.lohn_laeufe l on l.id = z.lauf_id
    where z.pfad = p_pfad
      and public.lohn_zettel_fahrer(l.firma_nr, z.ma_nr) = public.mein_fahrer_id()
  )
$$;

revoke all on function public.lohn_zettel_fahrer(text, integer), public.lohn_lauf_speichern(jsonb),
  public.lohn_person_zuordnen(text, integer, integer), public.fahrer_app_lohnzettel(integer),
  public.fahrer_app_dienstgeber(integer), public.lohn_pfad_erlaubt(text) from public, anon;
grant execute on function public.lohn_zettel_fahrer(text, integer), public.lohn_lauf_speichern(jsonb),
  public.lohn_person_zuordnen(text, integer, integer), public.fahrer_app_lohnzettel(integer),
  public.fahrer_app_dienstgeber(integer), public.lohn_pfad_erlaubt(text) to authenticated;


-- === Storage-Bucket ==========================================================
insert into storage.buckets (id, name, public) values ('lohnzettel', 'lohnzettel', false)
on conflict (id) do nothing;

drop policy if exists lohnzettel_app_insert on storage.objects;
drop policy if exists lohnzettel_app_update on storage.objects;
drop policy if exists lohnzettel_app_delete on storage.objects;
drop policy if exists lohnzettel_lesen      on storage.objects;
create policy lohnzettel_app_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'lohnzettel' and public.is_app_user());
create policy lohnzettel_app_update on storage.objects for update to authenticated
  using (bucket_id = 'lohnzettel' and public.is_app_user())
  with check (bucket_id = 'lohnzettel' and public.is_app_user());
create policy lohnzettel_app_delete on storage.objects for delete to authenticated
  using (bucket_id = 'lohnzettel' and public.is_app_user());
create policy lohnzettel_lesen on storage.objects for select to authenticated
  using (bucket_id = 'lohnzettel' and public.lohn_pfad_erlaubt(name));
