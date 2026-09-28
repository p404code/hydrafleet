-- Post & Strafen (Spec docs/superpowers/specs/2026-09-28-post-strafen-design.md)
-- USP-Postkorb Hydrafleet KG: Eingang, Antworten, Mieter. Schreibt nichts Bestehendes um.

-- Zugänge im Vault: USP-Eingangsschlüssel, Gmail, Anthropic
alter table public.verbindungen drop constraint if exists verbindungen_anbieter_check;
alter table public.verbindungen add constraint verbindungen_anbieter_check
  check (anbieter in ('bolt', 'uber', 'mypos', 'notion', 'usp', 'gmail', 'anthropic'));

-- === Mieter der ganzen Flotte, nach Zeitraum =================================
create table if not exists public.mietverhaeltnisse (
  id          serial primary key,
  kurz        text not null,                 -- 'EH', 'Sorhan' (Knopf)
  name        text not null,
  adresse     text not null,
  uid         text,
  fn          text,
  gueltig_von date,                          -- null = seit jeher
  gueltig_bis date,                          -- null = offen; inklusive
  constraint mietverhaeltnisse_zeitraum check (gueltig_von is null or gueltig_bis is null or gueltig_von <= gueltig_bis),
  constraint mietverhaeltnisse_keine_ueberschneidung
    exclude using gist (daterange(gueltig_von, gueltig_bis, '[]') with &&)
);
insert into public.mietverhaeltnisse (kurz, name, adresse, uid, fn, gueltig_von, gueltig_bis)
select * from (values
  ('Sorhan', 'Sorhan Taxi KG', 'Seitenstettengasse 5/37, 1010 Wien', null, null, null::date, date '2026-01-10'),
  ('EH', 'EH Limousinenservice KG', 'Thalhaimergasse 47/4, 1160 Wien', 'ATU74849827', '521134 z', date '2026-01-11', null::date)
) v where not exists (select 1 from public.mietverhaeltnisse);

-- === Eingang: ein Eintrag je PDF ===========================================
create table if not exists public.post_eingang (
  id                  uuid primary key default gen_random_uuid(),
  quelle              text not null check (quelle in ('usp', 'upload')),
  delivery_id         text unique,
  sha256              text not null unique,
  datei_pfad          text not null,
  dateiname           text,
  usp_absender        text,
  usp_betreff         text,
  zugestellt_am       timestamptz,
  eingelesen_am       timestamptz not null default now(),
  art                 text check (art in ('lenkererhebung','strafverfuegung','anonymverfuegung',
                                          'zahlungsaufforderung','mahnung','sonstige')),
  gz                  text,
  behoerde            text,
  kennzeichen         text,
  kennzeichen_key     text,          -- kein FK: fuhrpark wird bei jedem Notion-Sync ersetzt
  tatzeit             timestamptz,
  tatort              text,
  delikt              text,
  betrag              numeric(10,2),
  frist               date,
  antwort_email       text,
  volltext            text,
  auslese_roh         jsonb,
  pruef_grund         text,
  fahrer_vorschlag_id integer references public.fahrer(id) on delete set null,
  fahrer_id           integer references public.fahrer(id) on delete set null,
  status              text not null default 'neu'
                      check (status in ('neu','pruefen','offen','beantwortet','freigegeben','erledigt')),
  freigegeben_am      timestamptz,
  freigegeben_von     uuid,
  erledigt_am         timestamptz,
  erledigt_von        uuid,
  notiz               text,
  suche               tsvector generated always as (to_tsvector('german'::regconfig,
                        coalesce(gz,'') || ' ' || coalesce(kennzeichen,'') || ' ' || coalesce(behoerde,'') || ' ' ||
                        coalesce(usp_absender,'') || ' ' || coalesce(usp_betreff,'') || ' ' ||
                        coalesce(delikt,'') || ' ' || coalesce(tatort,'') || ' ' || coalesce(volltext,''))) stored
);
create index if not exists post_eingang_suche_idx on public.post_eingang using gin (suche);
create index if not exists post_eingang_gz_idx on public.post_eingang (gz);
create index if not exists post_eingang_status_idx on public.post_eingang (status, frist);

-- === Ausgang: jede Antwort im Wortlaut ======================================
create table if not exists public.post_ausgang (
  id                 uuid primary key default gen_random_uuid(),
  eingang_id         uuid references public.post_eingang(id) on delete set null,
  gz                 text not null,
  an                 text not null,
  betreff            text not null,
  text               text not null,
  mietverhaeltnis_id integer references public.mietverhaeltnisse(id),
  gmail_message_id   text,
  gmail_thread_id    text,
  gesendet_am        timestamptz,
  gesendet_von       uuid,
  test_an            text,           -- gesetzt = Probemail an diese Adresse, zählt nicht als Antwort
  fehler             text,
  quelle             text not null check (quelle in ('hydralink', 'gmail_abgleich')),
  erstellt_am        timestamptz not null default now()
);
create index if not exists post_ausgang_gz_idx on public.post_ausgang (gz);
-- Eine echte, erfolgreiche Antwort je GZ
create unique index if not exists post_ausgang_gz_einmal
  on public.post_ausgang (gz) where test_an is null and fehler is null;

-- === RLS: Büro liest alles, schreibt nur Mieter direkt ======================
alter table public.mietverhaeltnisse enable row level security;
alter table public.post_eingang      enable row level security;
alter table public.post_ausgang      enable row level security;

drop policy if exists app_users_all on public.mietverhaeltnisse;
create policy app_users_all on public.mietverhaeltnisse for all to authenticated
  using (public.is_app_user()) with check (public.is_app_user());
drop policy if exists app_users_read on public.post_eingang;
create policy app_users_read on public.post_eingang for select to authenticated using (public.is_app_user());
drop policy if exists app_users_read on public.post_ausgang;
create policy app_users_read on public.post_ausgang for select to authenticated using (public.is_app_user());
revoke all on public.mietverhaeltnisse, public.post_eingang, public.post_ausgang from anon;
grant select, insert, update, delete on public.mietverhaeltnisse to authenticated;
grant usage on sequence public.mietverhaeltnisse_id_seq to authenticated;
grant select on public.post_eingang, public.post_ausgang to authenticated;

-- === Hilfsfunktionen =========================================================
create or replace function public.mieter_zur_tatzeit(p_tatzeit timestamptz)
returns setof public.mietverhaeltnisse language sql stable security definer set search_path = public as $$
  select m.* from public.mietverhaeltnisse m
  where p_tatzeit is not null
    and (p_tatzeit at time zone 'Europe/Vienna')::date <@ daterange(m.gueltig_von, m.gueltig_bis, '[]')
$$;

-- Genau ein aktiver Fahrer mit diesem Kennzeichen -> seine id, sonst null
create or replace function public.post_fahrer_vorschlag(p_kennzeichen text)
returns integer language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then min(f.id) end
  from public.fahrer f
  where f.aktiv and coalesce(f.kennzeichen, '') <> ''
    and public.kennzeichen_key(p_kennzeichen) <> ''
    and public.kennzeichen_key(f.kennzeichen) = public.kennzeichen_key(p_kennzeichen)
$$;

create or replace function public.post_nur_buero() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'nicht_berechtigt' using errcode = '42501'; end if;
end $$;

create or replace function public.post_zuordnen(p_id uuid, p_fahrer_id integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set fahrer_id = p_fahrer_id where id = p_id and freigegeben_am is null;
  if not found then raise exception 'nicht_gefunden_oder_freigegeben'; end if;
end $$;

create or replace function public.post_freigeben(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang
     set status = 'freigegeben', freigegeben_am = now(), freigegeben_von = auth.uid()
   where id = p_id and fahrer_id is not null
     and art in ('strafverfuegung','anonymverfuegung','zahlungsaufforderung','mahnung');
  if not found then raise exception 'freigabe_nicht_moeglich'; end if;
end $$;

create or replace function public.post_freigabe_zuruecknehmen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set status = 'offen', freigegeben_am = null, freigegeben_von = null
   where id = p_id and freigegeben_am is not null;
end $$;

create or replace function public.post_erledigt(p_id uuid, p_notiz text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang
     set status = 'erledigt', erledigt_am = now(), erledigt_von = auth.uid(),
         notiz = coalesce(nullif(p_notiz, ''), notiz)
   where id = p_id;
end $$;

create or replace function public.post_wieder_oeffnen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang e
     set erledigt_am = null, erledigt_von = null,
         status = case
           when exists (select 1 from public.post_ausgang a where a.gz = e.gz and a.test_an is null and a.fehler is null)
             then 'beantwortet'
           when e.freigegeben_am is not null then 'freigegeben'
           when e.pruef_grund is not null then 'pruefen'
           else 'offen' end
   where e.id = p_id;
end $$;

create or replace function public.post_notiz(p_id uuid, p_notiz text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set notiz = nullif(p_notiz, '') where id = p_id;
end $$;

-- === Fahrerapp ===============================================================
create or replace function public.fahrer_app_strafen(p_fahrer_id integer default null)
returns table (id uuid, art text, behoerde text, gz text, tatzeit timestamptz, tatort text,
               delikt text, betrag numeric, frist date, pfad text)
language sql stable security definer set search_path = public as $$
  select e.id, e.art, e.behoerde, e.gz, e.tatzeit, e.tatort, e.delikt, e.betrag, e.frist, e.datei_pfad
  from public.post_eingang e
  where e.freigegeben_am is not null
    and e.fahrer_id = public.fahrer_app_ziel(p_fahrer_id)
  order by coalesce(e.tatzeit, e.eingelesen_am) desc
$$;

create or replace function public.post_pfad_erlaubt(p_pfad text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_app_user() or exists (
    select 1 from public.post_eingang e
    where e.datei_pfad = p_pfad and e.freigegeben_am is not null
      and e.fahrer_id = public.mein_fahrer_id()
  )
$$;

revoke all on function public.mieter_zur_tatzeit(timestamptz), public.post_fahrer_vorschlag(text),
  public.post_nur_buero(), public.post_zuordnen(uuid, integer), public.post_freigeben(uuid),
  public.post_freigabe_zuruecknehmen(uuid), public.post_erledigt(uuid, text), public.post_wieder_oeffnen(uuid),
  public.post_notiz(uuid, text), public.fahrer_app_strafen(integer), public.post_pfad_erlaubt(text)
  from public, anon;
grant execute on function public.mieter_zur_tatzeit(timestamptz), public.post_fahrer_vorschlag(text),
  public.post_zuordnen(uuid, integer), public.post_freigeben(uuid),
  public.post_freigabe_zuruecknehmen(uuid), public.post_erledigt(uuid, text), public.post_wieder_oeffnen(uuid),
  public.post_notiz(uuid, text), public.fahrer_app_strafen(integer), public.post_pfad_erlaubt(text)
  to authenticated;

-- === Storage: privater Bucket, Schreiben nur service_role (Edge Function) ===
insert into storage.buckets (id, name, public)
values ('post', 'post', false) on conflict (id) do nothing;
drop policy if exists post_lesen on storage.objects;
create policy post_lesen on storage.objects for select to authenticated
  using (bucket_id = 'post' and public.post_pfad_erlaubt(name));
