-- ============================================================================
-- Automatische Abrechnung: myPOS-Terminals ohne Fahrer als __MYPOS:<Terminal>__-Zeilen (Status MYPOS_UNASSIGNED) anlegen,
-- wie der AbrechnungsBot – dann lassen sie sich in der Abrechnung zuordnen (mypos_zuordnen).
-- Datum: 2026-10-19 (KW42 lief um 05:00 nicht, weil die Uber-Sitzung abgelaufen war; von Hand nachgeholt, Zeilen von Hand angelegt)
-- Rollback: montag_frueh aus 2026-10-19-abrechnung-api-status.sql; drop function mypos_offene_zeilen;
-- ============================================================================

create or replace function public.mypos_offene_zeilen(p_woche text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not exists (select 1 from public.abrechnung_api_laeufe where woche = p_woche and ergebnis = 'geschrieben') then return 0; end if;
  insert into public.settlements (woche, fahrer_name, status, mypos_summe, auszahlung, bruttoumsatz_gesamt)
  select m.woche, '__MYPOS:' || m.terminal || '__', 'MYPOS_UNASSIGNED', m.betrag, 0, 0
    from public.mypos_umsaetze m
   where m.woche = p_woche and m.fahrer_id is null and m.betrag <> 0
     and not exists (select 1 from public.settlements s where s.woche = m.woche and s.fahrer_name = '__MYPOS:' || m.terminal || '__');
  get diagnostics n = row_count;
  return n;
end $$;

do $do$
declare d text; neu text;
begin
  d := pg_get_functiondef('public.montag_frueh()'::regprocedure);
  neu := replace(d, 'perform public.abrechnung_auto_freigeben(w);',
                    'perform public.mypos_offene_zeilen(w);' || chr(10) || '    perform public.abrechnung_auto_freigeben(w);');
  if neu = d then raise exception 'Stelle (auto_freigeben) nicht gefunden'; end if;
  execute neu;
end $do$;

revoke all on function public.mypos_offene_zeilen(text) from public, anon, authenticated;
grant execute on function public.mypos_offene_zeilen(text) to service_role;
