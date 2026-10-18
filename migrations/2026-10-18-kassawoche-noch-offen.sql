-- ============================================================================
-- KW41 fertig machen (Betreiber 18.10.2026): Die Woche wurde gesamt ins Kassabuch uebernommen, aber nur ein Teil der
-- Fahrer bekam bar. Wer noch offen ist, wird einzeln auf "ueberweisen" gestellt (auszahlung_weg = revolut).
-- Regel neu: bar_woche gilt nur, solange der Fahrer in der Woche NICHT von Hand umgestellt wurde.
-- auszahlung_weg_setzen erlaubt das jetzt auch aus dem Status bar_woche (Bankdaten muessen geprueft sein).
-- Rollback: beide Ersetzungen umkehren.
-- ============================================================================
do $do$
declare d text; neu text;
begin
  d := pg_get_functiondef('public.auszahlung_status_basis(text)'::regprocedure);
  neu := replace(d, $x$when (select ja from kw) and c.summe = 0 then 'bar_woche'$x$,
                    $x$when (select ja from kw) and c.summe = 0 and c.weg_hand is null then 'bar_woche'$x$);
  if neu = d then raise exception 'Stelle bar_woche nicht gefunden'; end if;
  execute neu;
  d := pg_get_functiondef('public.auszahlung_weg_setzen(text, integer, text)'::regprocedure);
  neu := replace(d, $x$if st.status not in ('revolut_offen', 'bar_offen') then$x$, $x$if st.status not in ('revolut_offen', 'bar_offen', 'bar_woche') then$x$);
  if neu = d then raise exception 'Stelle weg_setzen nicht gefunden'; end if;
  execute neu;
end $do$;
