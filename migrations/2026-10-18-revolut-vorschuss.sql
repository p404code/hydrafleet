-- ============================================================================
-- Revolut-Ueberweisung als Vorschuss markieren (Betreiber 18.10.2026: "Ramsan Yutaev" 20 EUR, Ref. "41" = Vorschuss)
-- Datum: 2026-10-18
-- Ein Vorschuss zaehlt nicht fuer die Sperre "seit Freigabe schon ueberwiesen" (revolut_kandidaten).
-- Der Abruf (Upsert) laesst die Spalte unberuehrt. Setzen nur ueber revolut_buchung_vorschuss (Buero).
-- Rollback: alter table revolut_buchungen drop column vorschuss, drop column vorschuss_von;
--   drop function revolut_buchung_vorschuss; revolut_kandidaten aus 2026-10-18-revolut-buchungen.sql neu einspielen.
-- ============================================================================

alter table public.revolut_buchungen add column if not exists vorschuss boolean not null default false;
alter table public.revolut_buchungen add column if not exists vorschuss_von text;

drop trigger if exists protokoll_mitschreiben on public.revolut_buchungen;
create trigger protokoll_mitschreiben after update of vorschuss on public.revolut_buchungen
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

create or replace function public.revolut_buchung_vorschuss(p_id text, p_vorschuss boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  update public.revolut_buchungen
     set vorschuss = coalesce(p_vorschuss, false),
         vorschuss_von = case when coalesce(p_vorschuss, false) then coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro') end
   where id = p_id;
  if not found then raise exception 'Überweisung % nicht gefunden', p_id using errcode = 'P0002'; end if;
end $$;
revoke all on function public.revolut_buchung_vorschuss(text, boolean) from public, anon;
grant execute on function public.revolut_buchung_vorschuss(text, boolean) to authenticated;

create or replace function public.revolut_kandidaten(p_woche text)
returns table (notion_fahrer_id integer, name text, betrag numeric, kontoinhaber text, iban text, bic text, revtag text,
               geprueft boolean, counterparty_id text, counterparty_account_id text, empfaenger text,
               csv_exportiert numeric, zahlung_status text, zahlung_betrag numeric, seit_freigabe_ueberwiesen numeric)
language sql stable security definer set search_path = public as $$
  with fr as (select freigegeben_am from public.abrechnung_freigaben where woche = p_woche),
  z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)) as betrag
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
      and exists (select 1 from fr)
    group by 1
  )
  select f.notion_fahrer_id, f.name, round(z.betrag, 2), fb.kontoinhaber, fb.iban, fb.bic, fb.revtag,
         coalesce(fb.geprueft, false), fb.revolut_counterparty_id, fb.revolut_counterparty_account_id, fb.revolut_empfaenger,
         coalesce((select sum(e.betrag) from public.auszahlung_export e
                   where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id), 0),
         rz.status, rz.betrag,
         coalesce((select sum(b.betrag) from public.revolut_buchungen b, fr
                   where b.notion_fahrer_id = f.notion_fahrer_id and b.state in ('pending', 'completed')
                     and not b.vorschuss
                     and b.erstellt_am >= fr.freigegeben_am
                     and b.id is distinct from rz.revolut_transaction_id
                     and coalesce((substring(upper(b.referenz) from 'KW ?0*(\d{1,2})'))::integer,
                                  (substring(p_woche from 'W(\d{2})'))::integer) = (substring(p_woche from 'W(\d{2})'))::integer), 0)
  from z
  join public.fahrer f on f.id = z.fid and f.notion_fahrer_id is not null
  left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id
  left join public.revolut_zahlungen rz on rz.woche = p_woche and rz.notion_fahrer_id = f.notion_fahrer_id
  order by f.name
$$;
