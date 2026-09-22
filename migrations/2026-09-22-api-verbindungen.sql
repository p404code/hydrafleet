-- API-Verbindungen: Grundgeruest fuer automatischen Datenabruf (Bolt zuerst, Uber spaeter)
-- Anbieter-neutral. Die Rohdaten-Tabellen (bolt_orders, uber_reports) kommen separat,
-- weil ihre Spalten von der jeweiligen API-Antwort abhaengen.
--
-- Zugangsdaten liegen NUR im Vault. Pro Verbindung ein Secret, dessen Wert ein JSON-Objekt
-- ist (z.B. {"client_id":"...","client_secret":"..."}) - so bleibt die Tabelle gleich,
-- egal wie viele Felder ein Anbieter braucht.

-- === verbindungen ===
create table if not exists public.verbindungen (
  id              uuid primary key default gen_random_uuid(),
  anbieter        text not null check (anbieter in ('bolt', 'uber', 'mypos')),
  firma           text,                    -- null = gilt fuer alle Firmen (so bei Bolt)
  vault_secret_id uuid not null,           -- -> vault.secrets.id
  status          text not null default 'aktiv' check (status in ('aktiv', 'pausiert', 'fehler')),
  letzter_abruf   timestamptz,
  letzter_fehler  text,
  erstellt_am     timestamptz not null default now()
);

-- coalesce, weil NULL in Postgres nicht gleich NULL ist und 'ein Zugang pro Anbieter
-- ohne Firma' sonst mehrfach angelegt werden koennte
create unique index if not exists verbindungen_anbieter_firma_idx
  on public.verbindungen (anbieter, coalesce(firma, ''));

-- === sync_runs ===
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  verbindung_id uuid not null references public.verbindungen(id) on delete cascade,
  start         timestamptz not null default now(),
  ende          timestamptz,
  zeitraum_von  date,                      -- welcher Zeitraum abgerufen wurde
  zeitraum_bis  date,
  anzahl        integer not null default 0,
  status        text not null default 'laeuft' check (status in ('laeuft', 'ok', 'fehler')),
  fehler        text
);

create index if not exists sync_runs_verbindung_start_idx
  on public.sync_runs (verbindung_id, start desc);

-- === RLS: wie bei allen bestehenden Tabellen, anon hat keine Rechte ===
-- Dashboard-Nutzer duerfen nur lesen. Geschrieben wird ausschliesslich vom Sync
-- mit service_role, und das umgeht RLS ohnehin.
alter table public.verbindungen enable row level security;
alter table public.sync_runs    enable row level security;

drop policy if exists app_users_read on public.verbindungen;
create policy app_users_read on public.verbindungen
  for select to authenticated using (is_app_user());

drop policy if exists app_users_read on public.sync_runs;
create policy app_users_read on public.sync_runs
  for select to authenticated using (is_app_user());

-- === Zugangsdaten entschluesseln ===
-- Einzige Stelle, an der Klartext-Credentials entstehen. Nur service_role darf rufen,
-- damit das Frontend (anon/authenticated) auch bei einem Fehler nie drankommt.
create or replace function public.verbindung_zugang(p_verbindung_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  select ds.decrypted_secret
    into v_secret
    from public.verbindungen v
    join vault.decrypted_secrets ds on ds.id = v.vault_secret_id
   where v.id = p_verbindung_id
     and v.status = 'aktiv';

  if v_secret is null then
    raise exception 'Keine aktive Verbindung mit id %', p_verbindung_id;
  end if;

  return v_secret::jsonb;
end;
$$;

revoke all on function public.verbindung_zugang(uuid) from public, anon, authenticated;
grant execute on function public.verbindung_zugang(uuid) to service_role;
