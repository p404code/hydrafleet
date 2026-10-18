-- ============================================================================
-- Revolut Business API: Auszahlung als Payment-Draft (Teil B, beauftragt 18.10.2026)
-- Datum: 2026-10-18
--
-- Nur das Serdo-Konto (Entscheidung Betreiber 18.10.). Scopes READ + WRITE, KEIN PAY: die Edge Function
-- revolut-auszahlung legt nur Entwuerfe an, der Betreiber gibt sie in der Revolut-App frei.
-- revolut-webhook zieht den Status der echten Ueberweisung nach.
-- Je Woche und Fahrer hoechstens eine aktive Zahlung (unique). Ein in Revolut verworfener Entwurf
-- (status 'verworfen') oder eine gescheiterte Zahlung darf neu angelegt werden.
-- Schreiben nur die Edge Functions (service_role); das Buero liest.
--
-- Rollback: drop function revolut_kandidaten, revolut_counterparty_setzen, revolut_reservieren; drop table revolut_webhook_events,
--   revolut_zahlungen; drop trigger fahrer_bank_revolut_zurueck on fahrer_bank; drop function fahrer_bank_revolut_zurueck;
--   alter table fahrer_bank drop column revolut_counterparty_account_id, revolut_empfaenger;
-- ============================================================================

-- Gegenpartei bei Revolut: id + Konto-id der Gegenpartei, und ob per IBAN oder Revtag angelegt
alter table public.fahrer_bank add column if not exists revolut_counterparty_account_id text;
alter table public.fahrer_bank add column if not exists revolut_empfaenger text
  check (revolut_empfaenger is null or revolut_empfaenger in ('iban', 'revtag'));

-- Bankdaten geaendert -> Gegenpartei passt nicht mehr (zusaetzlich zu bank_schreiben, auch bei Handaenderung)
create or replace function public.fahrer_bank_revolut_zurueck() returns trigger language plpgsql as $$
begin
  if (old.iban, old.kontoinhaber, old.bic, old.revtag) is distinct from (new.iban, new.kontoinhaber, new.bic, new.revtag) then
    new.revolut_counterparty_id := null; new.revolut_counterparty_account_id := null; new.revolut_empfaenger := null;
    new.geprueft := false; new.geprueft_am := null; new.geprueft_von := null;
  end if;
  return new;
end $$;
drop trigger if exists fahrer_bank_revolut_zurueck on public.fahrer_bank;
create trigger fahrer_bank_revolut_zurueck before update on public.fahrer_bank
  for each row execute function public.fahrer_bank_revolut_zurueck();

create table if not exists public.revolut_zahlungen (
  id                     bigint generated always as identity primary key,
  woche                  text not null,
  notion_fahrer_id       integer not null,
  name                   text not null,
  betrag                 numeric(10,2) not null check (betrag > 0 and betrag <= 20000),
  iban_ende              text,
  empfaenger             text not null check (empfaenger in ('iban', 'revtag')),
  referenz               text not null,
  revolut_counterparty_id text,
  revolut_draft_id       text,
  revolut_transaction_id text unique,
  status                 text not null default 'reserviert'
    check (status in ('reserviert', 'entwurf', 'verworfen', 'pending', 'completed', 'declined', 'failed', 'reverted')),
  fehler                 text,
  erstellt_am            timestamptz not null default now(),
  erstellt_von           text not null,
  aktualisiert_am        timestamptz not null default now(),
  unique (woche, notion_fahrer_id)
);
create unique index if not exists revolut_zahlungen_referenz on public.revolut_zahlungen (referenz);

-- Doppelte Webhook-Zustellungen (Revolut wiederholt) erkennen
create table if not exists public.revolut_webhook_events (
  schluessel   text primary key,
  event        text not null,
  empfangen_am timestamptz not null default now(),
  nutzlast     jsonb not null
);

alter table public.revolut_zahlungen enable row level security;
alter table public.revolut_webhook_events enable row level security;
revoke all on public.revolut_zahlungen, public.revolut_webhook_events from public, anon, authenticated;
grant select on public.revolut_zahlungen to authenticated;
drop policy if exists buero_liest on public.revolut_zahlungen;
create policy buero_liest on public.revolut_zahlungen for select to authenticated using (public.is_app_user());

drop trigger if exists protokoll_mitschreiben on public.revolut_zahlungen;
create trigger protokoll_mitschreiben after insert or update or delete on public.revolut_zahlungen
  for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

-- Protokoll: Bankdaten und Auszahlungen gehoeren zum Bereich Geld
create or replace function public.protokoll_bereich(p_tabelle text) returns text
language sql immutable as $$
  select case p_tabelle
    when 'settlements' then 'geld' when 'abrechnung_posten' then 'geld' when 'kassier_zahlungen' then 'geld'
    when 'fahrer_bank' then 'geld' when 'bank_bestaetigung' then 'geld' when 'auszahlung_export' then 'geld'
    when 'revolut_zahlungen' then 'geld'
    when 'abrechnung_freigaben' then 'freigaben'
    when 'post_eingang' then 'post' when 'mietverhaeltnisse' then 'post' when 'post_ausgang' then 'post'
    when 'zuordnung_manuell' then 'zuordnungen' when 'lohn_personen' then 'zuordnungen' when 'name_aliases' then 'zuordnungen'
    when 'fahrer_app_zugang' then 'zugaenge'
    when 'customers' then 'stammdaten' when 'companies' then 'stammdaten'
    when 'kassabuch' then 'kassa' when 'sync_runs' then 'sync'
    else 'sonst' end
$$;

-- Je Fahrer der Woche: "Du bekommst" (alle seine Zeilen, wie auszahlung_liste/bank_betrag), Bankdaten,
-- Revolut-Stand und ob er schon per CSV ausgezahlt wurde. Nur fuer freigegebene Wochen. Nur service_role.
create or replace function public.revolut_kandidaten(p_woche text)
returns table (notion_fahrer_id integer, name text, betrag numeric, kontoinhaber text, iban text, bic text, revtag text,
               geprueft boolean, counterparty_id text, counterparty_account_id text, empfaenger text,
               csv_exportiert numeric, zahlung_status text, zahlung_betrag numeric)
language sql stable security definer set search_path = public as $$
  with z as (
    select public.settlement_fahrer(s.telefon, s.fahrer_name) as fid,
           sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)) as betrag
    from public.settlements s
    where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
      and exists (select 1 from public.abrechnung_freigaben fr where fr.woche = p_woche)
    group by 1
  )
  select f.notion_fahrer_id, f.name, round(z.betrag, 2), fb.kontoinhaber, fb.iban, fb.bic, fb.revtag,
         coalesce(fb.geprueft, false), fb.revolut_counterparty_id, fb.revolut_counterparty_account_id, fb.revolut_empfaenger,
         coalesce((select sum(e.betrag) from public.auszahlung_export e
                   where e.woche = p_woche and e.notion_fahrer_id = f.notion_fahrer_id), 0),
         rz.status, rz.betrag
  from z
  join public.fahrer f on f.id = z.fid and f.notion_fahrer_id is not null
  left join public.fahrer_bank fb on fb.notion_fahrer_id = f.notion_fahrer_id
  left join public.revolut_zahlungen rz on rz.woche = p_woche and rz.notion_fahrer_id = f.notion_fahrer_id
  order by f.name
$$;

-- Gegenpartei merken - nur wenn die Bankdaten inzwischen nicht geaendert wurden (gleiche IBAN, geprueft)
create or replace function public.revolut_counterparty_setzen(p_nr integer, p_iban text, p_cp text, p_cp_konto text, p_art text)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update public.fahrer_bank set revolut_counterparty_id = p_cp, revolut_counterparty_account_id = p_cp_konto, revolut_empfaenger = p_art
     where notion_fahrer_id = p_nr and iban = p_iban and geprueft
    returning 1)
  select exists (select 1 from u)
$$;

-- Vor dem Entwurf je Fahrer eine Zeile reservieren (atomar: zwei gleichzeitige Klicks legen nichts doppelt an).
-- Liefert die Nrn., die wirklich reserviert wurden; eine verworfene/gescheiterte Zahlung wird wiederverwendet.
-- p_posten: [{"nr":1,"name":"…","betrag":12.3,"iban_ende":"1000","empfaenger":"iban","referenz":"…","cp":"…"}]
create or replace function public.revolut_reservieren(p_woche text, p_posten jsonb, p_von text)
returns setof integer language plpgsql security definer set search_path = public as $$
declare e jsonb; v_nr integer;
begin
  for e in select * from jsonb_array_elements(p_posten) loop
    v_nr := null;
    insert into public.revolut_zahlungen as z (woche, notion_fahrer_id, name, betrag, iban_ende, empfaenger, referenz,
                                               revolut_counterparty_id, status, erstellt_von)
    values (p_woche, (e->>'nr')::integer, e->>'name', (e->>'betrag')::numeric, e->>'iban_ende', e->>'empfaenger',
            e->>'referenz', e->>'cp', 'reserviert', p_von)
    on conflict (woche, notion_fahrer_id) do update
      set name = excluded.name, betrag = excluded.betrag, iban_ende = excluded.iban_ende, empfaenger = excluded.empfaenger,
          referenz = excluded.referenz, revolut_counterparty_id = excluded.revolut_counterparty_id, status = 'reserviert',
          revolut_draft_id = null, revolut_transaction_id = null, fehler = null, erstellt_von = excluded.erstellt_von,
          erstellt_am = now(), aktualisiert_am = now()
      where z.status in ('verworfen', 'failed', 'declined')
    returning z.notion_fahrer_id into v_nr;
    if v_nr is not null then return next v_nr; end if;
  end loop;
end $$;

revoke all on function public.revolut_kandidaten(text), public.revolut_counterparty_setzen(integer, text, text, text, text),
  public.revolut_reservieren(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.revolut_kandidaten(text), public.revolut_counterparty_setzen(integer, text, text, text, text),
  public.revolut_reservieren(text, jsonb, text) to service_role;

-- Advisor: fester search_path
alter function public.fahrer_bank_revolut_zurueck() set search_path = public;
