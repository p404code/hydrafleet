-- ============================================================================
-- Pauschalen in HYDRAlink – Schritt 0: Verlauf + Übernahme aus Notion
-- Spec: docs/superpowers/specs/2026-10-31-pauschalen-design.md
-- Datum: 2026-10-31
--
-- Legt den Pauschalen-Verlauf an (nur anhängen, Schlüssel Notion-Fahrer-Nr.) und übernimmt
-- die heutigen Pauschalen aller aktiven Fahrer aus `fahrer` (= Notion-Stand).
-- WIRKT NOCH NICHT auf die Abrechnung: Bot, api_abrechnung usw. lesen weiter `fahrer`,
-- und der Wächter, der n8n das Überschreiben verbietet, kommt erst beim Scharfschalten.
-- Bis dahin hängt pauschalen_uebernehmen() Notion-Änderungen als neue Übernahme-Zeile an.
--
-- Rollback: drop view pauschalen_abweichung; drop function pauschalen_uebernehmen, pauschale_fuer,
--   pauschale_stichwoche, pauschale_aus_fahrer, woche_plus, pauschalen_gesperrt; drop table pauschalen;
-- ============================================================================

create table if not exists public.pauschalen (
  id               bigint generated always as identity primary key,
  fahrer_nr        integer not null,
  art              text not null check (art in ('fix', 'f11', 'f12', 'eigene')),
  betrag           numeric(10,2) not null check (betrag >= 0),
  prozent_satz     numeric(5,2),
  prozent_schwelle numeric(10,2),
  gilt_ab          text not null check (gilt_ab ~ '^\d{4}-W\d{2}$'),
  gilt_bis         text check (gilt_bis ~ '^\d{4}-W\d{2}$'),
  grund            text check (char_length(grund) <= 200),
  quelle           text not null check (quelle in ('hand', 'uebernahme', 'neuanlage')),
  von              text not null,
  am               timestamptz not null default now(),
  check (gilt_bis is null or gilt_bis >= gilt_ab),
  -- coalesce: ein leerer Wert darf die Regel nicht still erfuellen
  check (coalesce(case when art = 'eigene'
              then prozent_satz > 0 and prozent_satz <= 100 and prozent_schwelle >= 0
              else prozent_satz is null and prozent_schwelle is null end, false))
);
create index if not exists pauschalen_nr on public.pauschalen (fahrer_nr, gilt_ab);

-- Verlauf ist unveränderlich (wie fahrer_bank_verlauf / kassabuch). Zurücknehmen = neue Zeile.
create or replace function public.pauschalen_gesperrt() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Der Pauschalen-Verlauf wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists pauschalen_gesperrt on public.pauschalen;
create trigger pauschalen_gesperrt before update or delete on public.pauschalen
  for each row execute function public.pauschalen_gesperrt();
drop trigger if exists pauschalen_gesperrt_alles on public.pauschalen;
create trigger pauschalen_gesperrt_alles before truncate on public.pauschalen
  for each statement execute function public.pauschalen_gesperrt();

alter table public.pauschalen enable row level security;
revoke all on public.pauschalen from public, anon, authenticated;
grant select on public.pauschalen to authenticated;
drop policy if exists buero_liest on public.pauschalen;
create policy buero_liest on public.pauschalen for select to authenticated using (public.is_app_user());

-- ---------- Wochen ----------
-- ISO-Woche 'JJJJ-Wnn' + n Wochen (über den Jahreswechsel, 2026 hat eine KW53)
create or replace function public.woche_plus(p_woche text, p_n integer default 1) returns text
language sql immutable set search_path = public as $$
  select to_char(to_date(p_woche, 'IYYY-"W"IW') + 7 * p_n, 'IYYY-"W"IW')
$$;

-- Nächste abzurechnende Woche = Woche nach der letzten Freigabe
create or replace function public.pauschale_stichwoche() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(public.woche_plus(max(woche)), to_char(now() at time zone 'Europe/Vienna', 'IYYY-"W"IW'))
    from public.abrechnung_freigaben
$$;

-- ---------- Welche Zeile gilt ----------
-- Von allen Einträgen, die die Woche abdecken, gilt der zuletzt gespeicherte.
-- security invoker: die RLS von pauschalen greift (Fahrer sehen nichts) – als definer war sie für jeden
-- angemeldeten Benutzer per /rpc aufrufbar (am 31.10. live nachgezogen, Migration pauschalen_rechte_fix).
create or replace function public.pauschale_fuer(p_fahrer_nr integer, p_woche text)
returns public.pauschalen language sql stable security invoker set search_path = public as $$
  select p.* from public.pauschalen p
   where p.fahrer_nr = p_fahrer_nr and p.gilt_ab <= p_woche and (p.gilt_bis is null or p.gilt_bis >= p_woche)
   order by p.am desc, p.id desc limit 1
$$;

-- Heutige fahrer-Spalten -> Art (wie der Bot rechnet: f11/f12 fest, sonst eigener Satz falls > 0)
create or replace function public.pauschale_aus_fahrer(p_mietmodell text, p_satz numeric, p_schwelle numeric,
  out art text, out prozent_satz numeric, out prozent_schwelle numeric)
language sql immutable set search_path = public as $$
  select case when p_mietmodell in ('f11', 'f12') then p_mietmodell
              when coalesce(p_satz, 0) > 0 then 'eigene' else 'fix' end,
         case when p_mietmodell not in ('f11', 'f12') and coalesce(p_satz, 0) > 0 then p_satz end,
         case when p_mietmodell not in ('f11', 'f12') and coalesce(p_satz, 0) > 0 then coalesce(p_schwelle, 0) end
$$;

-- ---------- Abweichung (Sicherheitsnetz) ----------
-- Aktive Fahrer, deren fahrer-Spalten nicht zur gültigen Pauschale der Stichwoche passen
-- oder die noch gar keinen Eintrag haben. Nach der Übernahme leer.
create or replace view public.pauschalen_abweichung with (security_invoker = true) as
with s as (select public.pauschale_stichwoche() as woche),
f as (
  select f.id, f.notion_fahrer_id as nr, f.name, f.mietmodell, f.basis_miete, f.prozent_satz, f.prozent_schwelle,
         a.art as f_art, a.prozent_satz as f_satz, a.prozent_schwelle as f_schwelle
    from public.fahrer f, lateral public.pauschale_aus_fahrer(f.mietmodell, f.prozent_satz, f.prozent_schwelle) a
   where f.aktiv and f.notion_fahrer_id is not null
)
select f.nr as fahrer_nr, f.name, s.woche as stichwoche,
       f.f_art as fahrer_art, f.basis_miete as fahrer_betrag, f.f_satz as fahrer_satz, f.f_schwelle as fahrer_schwelle,
       p.art, p.betrag, p.prozent_satz, p.prozent_schwelle,
       case when p.id is null then 'kein Eintrag' else 'weicht ab' end as befund
  from f cross join s
  left join lateral public.pauschale_fuer(f.nr, s.woche) p on true
 where p.id is null
    or (p.art, p.betrag, p.prozent_satz, p.prozent_schwelle)
       is distinct from (f.f_art, f.basis_miete::numeric(10,2), f.f_satz::numeric(5,2), f.f_schwelle::numeric(10,2));

-- ---------- Übernahme ----------
-- Hängt für jeden aktiven Fahrer ohne passenden Eintrag eine Übernahme-Zeile ab der Stichwoche an.
-- Wiederholbar: wer schon passt, bekommt nichts. Nur service_role / SQL-Fenster.
create or replace function public.pauschalen_uebernehmen() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.pauschalen (fahrer_nr, art, betrag, prozent_satz, prozent_schwelle, gilt_ab, quelle, von)
  select distinct on (a.fahrer_nr) a.fahrer_nr, a.fahrer_art, a.fahrer_betrag, a.fahrer_satz, a.fahrer_schwelle,
         a.stichwoche, 'uebernahme', 'Übernahme aus Notion'
    from public.pauschalen_abweichung a
   order by a.fahrer_nr;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pauschalen_uebernehmen() from public, anon, authenticated;
revoke all on function public.pauschale_stichwoche() from public, anon;
revoke all on function public.pauschale_fuer(integer, text) from public, anon;
-- ausdruecklich (live ohnehin per Supabase-Standard): die Ansicht pauschalen_abweichung braucht es fuers Buero,
-- Fahrer sehen dank security invoker + RLS nichts
grant execute on function public.pauschale_fuer(integer, text) to authenticated;

select public.pauschalen_uebernehmen() as uebernommen;
