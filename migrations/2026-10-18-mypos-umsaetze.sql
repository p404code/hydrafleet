-- ============================================================================
-- myPOS-Umsaetze aus dem myPOS-Kontoauszug (account_transactions_*.xlsx) fuer die automatische Abrechnung
-- Datum: 2026-10-18 (Betreiber schickt den Auszug fuer KW42; myPOS-API kommt mit dem neuen myPOS-Konto)
--
-- mypos_umsaetze: je Woche und Terminal die Summe der Kartenzahlungen (wie der Bot: alle Betraege <> 0 je Terminal).
-- Fahrer ueber die Notion-Terminal-Zuordnung (n8n-Webhook mypos-terminals, Feld "Text") -> mypos_fahrer_id():
-- exakter Name, name_key oder name_aliases, nur bei genau einem aktiven Fahrer.
-- api_abrechnung: mypos_summe = CSV-Wert (settlements), sonst mypos_umsaetze - die CSV gilt, wenn sie da ist.
-- abrechnung_api_schreiben schreibt mypos_summe jetzt mit (vorher 0).
-- Die View und die Funktion werden per Textersetzung geaendert (jede Stelle wird geprueft), damit nichts anderes kippt.
--
-- Rollback: Ersetzungen umkehren (mpj/mp entfernen, mypos_summe wieder 0 in abrechnung_api_schreiben); drop table mypos_umsaetze;
--   drop function mypos_fahrer_id;
-- ============================================================================

create table if not exists public.mypos_umsaetze (
  woche          text not null,
  terminal       text not null,
  betrag         numeric(12,2) not null,
  anzahl         integer not null,
  fahrer_text    text,
  fahrer_id      integer,
  datei          text,
  letzte_buchung timestamptz,
  importiert_am  timestamptz not null default now(),
  primary key (woche, terminal)
);
alter table public.mypos_umsaetze enable row level security;
revoke all on public.mypos_umsaetze from public, anon, authenticated;
grant select on public.mypos_umsaetze to authenticated;
drop policy if exists buero_liest on public.mypos_umsaetze;
create policy buero_liest on public.mypos_umsaetze for select to authenticated using (public.is_app_user());

create or replace function public.mypos_fahrer_id(p_text text) returns integer
language sql stable security definer set search_path = public as $$
  select min(f.id) from public.fahrer f
  where f.aktiv and coalesce(btrim(p_text), '') <> ''
    and (lower(f.name) = lower(btrim(p_text)) or public.name_key(f.name) = public.name_key(p_text)
         or f.name = (select a.fahrer_name from public.name_aliases a where a.csv_name = lower(btrim(p_text))))
  having count(distinct f.id) = 1
$$;

do $do$
declare d text; neu text; opts text[];
begin
  select pg_get_viewdef('public.api_abrechnung'::regclass), c.reloptions into d, opts
    from pg_class c where c.oid = 'public.api_abrechnung'::regclass;
  neu := regexp_replace(d, '\),\s*alt AS \(',
    '), mp AS (SELECT m.woche, m.fahrer_id, round(sum(m.betrag), 2) AS summe FROM mypos_umsaetze m WHERE m.fahrer_id IS NOT NULL GROUP BY m.woche, m.fahrer_id), alt AS (');
  if neu = d then raise exception 'Stelle 1 (alt AS) nicht gefunden'; end if; d := neu;
  neu := regexp_replace(d, '(WHERE \(?alt\.fahrer_id IS NOT NULL\)?)\s*\),\s*eingang AS \(',
    '\1 UNION SELECT mp.woche, mp.fahrer_id FROM mp), eingang AS (');
  if neu = d then raise exception 'Stelle 2 (schluessel) nicht gefunden'; end if; d := neu;
  neu := regexp_replace(d, 'COALESCE\(a\.mypos_summe, \(?0\)?::numeric\) AS mypos_summe',
    'COALESCE(a.mypos_summe, mpj.summe, (0)::numeric) AS mypos_summe');
  if neu = d then raise exception 'Stelle 3 (mypos_summe) nicht gefunden'; end if; d := neu;
  neu := regexp_replace(d, '(LEFT JOIN fahrer f ON \(+f\.id = k\.fahrer_id\)+)',
    '\1 LEFT JOIN mp mpj ON mpj.woche = k.woche AND mpj.fahrer_id = k.fahrer_id');
  if neu = d then raise exception 'Stelle 4 (join) nicht gefunden'; end if; d := neu;
  execute 'create or replace view public.api_abrechnung as ' || d;
  if opts is not null then execute format('alter view public.api_abrechnung set (%s)', array_to_string(opts, ', ')); end if;

  d := pg_get_functiondef('public.abrechnung_api_schreiben(text, boolean)'::regprocedure);
  neu := replace(d, 'coalesce(a.uber_auszahlung, 0), 0, coalesce(a.bruttoumsatz_gesamt, 0)',
                    'coalesce(a.uber_auszahlung, 0), coalesce(a.mypos_summe, 0), coalesce(a.bruttoumsatz_gesamt, 0)');
  if neu = d then raise exception 'Stelle 5 (mypos in abrechnung_api_schreiben) nicht gefunden'; end if; d := neu;
  neu := replace(d, '''Automatisch aus Bolt + Uber – myPOS fehlt, kommt mit dem CSV-Upload''',
    '''Automatisch aus Bolt + Uber'' || case when exists (select 1 from public.mypos_umsaetze m where m.woche = p_woche) then '' + myPOS-Auszug'' else '' – myPOS fehlt, kommt mit dem CSV-Upload'' end');
  if neu = d then raise exception 'Stelle 6 (Hinweis) nicht gefunden'; end if;
  execute neu;
end $do$;

revoke all on function public.mypos_fahrer_id(text) from public, anon, authenticated;
grant execute on function public.mypos_fahrer_id(text) to service_role;
