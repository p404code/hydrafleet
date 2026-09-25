-- ============================================================================
-- Dienstgeber-Angaben je Lohn-Firma (Firmen-Nr aus dem Lohnzettel):
-- Geschaeftsfuehrer + Adresse fuer Firmen, die nicht unter companies (Rechnungen)
-- stehen sollen, z. B. E&E Taxi KG. companies bleibt Fallback.
-- Fahrerapp zeigt: Firmenname + Geschaeftsfuehrer (+ Adresse, falls vorhanden).
-- ============================================================================

create table if not exists public.lohn_firmen (
  firma_nr text primary key,
  geschaeftsfuehrer text,
  adresse text,
  geaendert_am timestamptz not null default now()
);
alter table public.lohn_firmen enable row level security;
drop policy if exists app_users_read on public.lohn_firmen;
create policy app_users_read on public.lohn_firmen for select to authenticated using (public.is_app_user());
grant select on public.lohn_firmen to authenticated;

insert into public.lohn_firmen (firma_nr, geschaeftsfuehrer)
values ('200218', 'Ladislav Kallay')   -- E&E Taxi KG
on conflict (firma_nr) do update set geschaeftsfuehrer = excluded.geschaeftsfuehrer, geaendert_am = now();

-- Rueckgabetyp aendert sich (neue Spalte) -> neu anlegen
drop function if exists public.fahrer_app_dienstgeber(integer);
create function public.fahrer_app_dienstgeber(p_fahrer_id integer default null)
returns table (firma_name text, adresse text, monat date, geschaeftsfuehrer text)
language sql stable security definer set search_path = public as $$
  with meine as (
    select l.firma_nr, l.firma_name, l.monat
    from public.lohn_zettel z join public.lohn_laeufe l on l.id = z.lauf_id
    where public.lohn_zettel_fahrer(l.firma_nr, z.ma_nr) = public.fahrer_app_ziel(p_fahrer_id)
  )
  select distinct m.firma_name,
         coalesce(nullif(trim(f.adresse), ''), c.address),
         m.monat,
         coalesce(nullif(trim(f.geschaeftsfuehrer), ''), nullif(trim(c.gf), ''))
  from meine m
  left join public.lohn_firmen f on f.firma_nr = m.firma_nr
  left join public.companies c on c.name = m.firma_name
  where m.monat = (select max(monat) from meine)
  order by m.firma_name
$$;
revoke all on function public.fahrer_app_dienstgeber(integer) from public, anon;
grant execute on function public.fahrer_app_dienstgeber(integer) to authenticated;
