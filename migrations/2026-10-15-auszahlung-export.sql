-- ============================================================================
-- Revolut-Sammelueberweisung als CSV (Dashboard → Abrechnung → „Revolut-CSV“)
-- Datum: 2026-10-15
--
-- Fahrer mit hinterlegter IBAN. Hat er sie fuer die Woche bestaetigt, kommen IBAN und Kontoinhaber
-- aus der Bestaetigung (bank_bestaetigung, genau das, was er gesehen hat), sonst die aktuell
-- hinterlegten (fahrer_bank) - Korrektur des Betreibers am 15.10.: auch nicht bestaetigte kommen
-- auf die Liste; auszahlung_export.bestaetigt haelt fest, welche es waren. Nie Werte aus dem
-- Browser ausser dem Betrag, den das Buero aendern darf.
-- Jeder Export wird gespeichert; ein zweiter Export fuer denselben Fahrer und dieselbe Woche
-- nur ausdruecklich (p_nochmal), damit nicht doppelt ueberwiesen wird.
-- Welches Revolut-Konto (Serdo/E&E) zahlt, entscheidet das Buero beim Hochladen.
--
-- Rollback: drop function auszahlung_export_speichern, auszahlung_liste; drop table auszahlung_export;
-- ============================================================================

create table if not exists public.auszahlung_export (
  id               bigint generated always as identity primary key,
  lauf             uuid not null,
  woche            text not null,
  notion_fahrer_id integer not null,
  name             text not null,
  iban             text not null,
  kontoinhaber     text not null,
  betrag           numeric(10,2) not null check (betrag > 0),
  referenz         text not null,
  exportiert_am    timestamptz not null default now(),
  exportiert_von   text not null,
  bestaetigt       boolean not null default true
);
alter table public.auszahlung_export add column if not exists bestaetigt boolean not null default true;
create index if not exists auszahlung_export_woche on public.auszahlung_export (woche, notion_fahrer_id);

alter table public.auszahlung_export enable row level security;
revoke all on public.auszahlung_export from public, anon, authenticated;
grant select on public.auszahlung_export to authenticated;
drop policy if exists buero_liest on public.auszahlung_export;
create policy buero_liest on public.auszahlung_export for select to authenticated using (public.is_app_user());

drop trigger if exists protokoll_mitschreiben on public.auszahlung_export;
create trigger protokoll_mitschreiben after insert or update or delete on public.auszahlung_export
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

-- Je Fahrer der Woche: "Du bekommst" (alle seine Zeilen), IBAN (bestaetigt, sonst hinterlegt), schon exportiert.
-- Abrechnungszeilen ohne Fahrer (settlement_fahrer = null) koennen keine IBAN haben und fehlen hier.
drop function if exists public.auszahlung_liste(text);
create or replace function public.auszahlung_liste(p_woche text)
returns table (fahrer_id integer, notion_fahrer_id integer, name text, du_bekommst numeric,
               iban text, kontoinhaber text, bestaetigt boolean, bestaetigt_am timestamptz, hat_iban boolean, exportiert numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  return query
  with z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)) as betrag
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    group by 1
  )
  select f.id, f.notion_fahrer_id, f.name, round(z.betrag, 2), coalesce(bb.iban, fb.iban), coalesce(bb.kontoinhaber, fb.kontoinhaber),
         bb.notion_fahrer_id is not null, bb.bestaetigt_am,
         fb.notion_fahrer_id is not null,
         coalesce((select sum(e.betrag) from public.auszahlung_export e
                   where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id), 0)
  from z
  join public.fahrer f on f.id = z.fid
  left join public.bank_bestaetigung bb on bb.woche = p_woche and bb.notion_fahrer_id = f.notion_fahrer_id
  left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id;
end $$;

-- Speichert einen Export und liefert genau die Zeilen fuer die CSV.
-- p_posten: [{"nr": <notion_fahrer_id>, "betrag": <euro>}, …]
drop function if exists public.auszahlung_export_speichern(text, jsonb, boolean);
create or replace function public.auszahlung_export_speichern(p_woche text, p_posten jsonb, p_nochmal boolean default false)
returns table (name text, iban text, land text, betrag numeric, referenz text, bestaetigt boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r record; bb public.bank_bestaetigung; fb public.fahrer_bank; v_iban text; v_inhaber text; v_best boolean;
  v_betrag numeric; v_ref text; v_name text;
  v_lauf uuid := gen_random_uuid();
  v_von text := coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro');
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_posten is null or jsonb_typeof(p_posten) <> 'array' or jsonb_array_length(p_posten) = 0 then
    raise exception 'Keine Fahrer ausgewählt' using errcode = '22023'; end if;
  for r in select (e->>'nr')::integer as nr, (e->>'betrag')::numeric as betrag from jsonb_array_elements(p_posten) e loop
    v_betrag := round(r.betrag, 2);
    if v_betrag is null or v_betrag <= 0 or v_betrag > 20000 then
      raise exception 'Betrag für Fahrer Nr. % muss zwischen 0 und 20.000 € liegen', r.nr using errcode = '22023'; end if;
    select * into bb from public.bank_bestaetigung b where b.woche = p_woche and b.notion_fahrer_id = r.nr;
    select * into fb from public.fahrer_bank b where b.notion_fahrer_id = r.nr;
    v_best := bb.notion_fahrer_id is not null;
    v_iban := coalesce(bb.iban, fb.iban); v_inhaber := coalesce(bb.kontoinhaber, fb.kontoinhaber);
    if v_iban is null then
      raise exception 'Fahrer Nr. % hat keine IBAN hinterlegt', r.nr using errcode = '22023'; end if;
    if not coalesce(p_nochmal, false) and exists (select 1 from public.auszahlung_export e
                                                 where e.woche = p_woche and e.notion_fahrer_id = r.nr) then
      raise exception 'Fahrer Nr. % ist für % schon exportiert', r.nr, p_woche using errcode = 'P0001'; end if;
    select f.name into v_name from public.fahrer f where f.notion_fahrer_id = r.nr and f.aktiv limit 1;
    v_ref := 'Auszahlung KW' || coalesce(ltrim(substring(p_woche from 'W(\d+)'), '0'), '') || ' FHR-' || r.nr;
    insert into public.auszahlung_export (lauf, woche, notion_fahrer_id, name, iban, kontoinhaber, betrag, referenz, exportiert_von, bestaetigt)
    values (v_lauf, p_woche, r.nr, coalesce(v_name, v_inhaber), v_iban, v_inhaber, v_betrag, v_ref, v_von, v_best);
    name := v_inhaber; iban := v_iban; land := left(v_iban, 2); betrag := v_betrag; referenz := v_ref; bestaetigt := v_best;
    return next;
  end loop;
end $$;

revoke all on function public.auszahlung_liste(text), public.auszahlung_export_speichern(text, jsonb, boolean) from public, anon;
grant execute on function public.auszahlung_liste(text), public.auszahlung_export_speichern(text, jsonb, boolean) to authenticated;
