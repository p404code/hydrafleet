-- ============================================================================
-- Pauschalen – Schwelle 0 bleibt 0 („% vom ganzen Umsatz“), wie im AbrechnungsBot nach der Änderung
-- Spec: docs/superpowers/specs/2026-10-31-pauschalen-design.md (Abschnitt „Die eine Bot-Änderung“)
--
-- Bisher wurde eine Schwelle 0 überall zu 1.200 (Bot: `|| 1200`, SQL: coalesce(nullif(x, 0), 1200)).
-- Nur leer (null) wird noch zu 1.200. Für alle heutigen Fahrer ohne Wirkung: nachgerechnet am 31.10.2026
-- für KW42 + KW43 (110 Zeilen), alt = neu – f11/f12 haben feste Schwellen, fix hat Satz 0.
-- Mit dem Scharfschalten einspielen (zusammen mit der Bot-Zeile).
--
-- Rollback: dieselben Stellen wieder auf coalesce(nullif(…, 0), 1200)
-- ============================================================================

create or replace function public.prozent_nach_regel(p_mietmodell text, p_brutto numeric, p_satz numeric, p_schwelle numeric)
returns numeric language sql immutable set search_path = public as $$
  select round(case p_mietmodell
    when 'f11' then greatest(p_brutto - 1100, 0) * 0.10
    when 'f12' then greatest(p_brutto - 1200, 0) * 0.10
    else case when coalesce(p_satz, 0) > 0 and p_brutto > coalesce(p_schwelle, 1200)
              then (p_brutto - coalesce(p_schwelle, 1200)) * p_satz / 100 else 0 end end, 2)
$$;

-- api_abrechnung ist groß: nur die eine Stelle im live gespeicherten Text ersetzen, Optionen behalten.
do $$
declare
  d   text := pg_get_viewdef('public.api_abrechnung'::regclass, true);
  alt text := 'COALESCE(NULLIF(f.prozent_schwelle, 0::numeric), 1200::numeric)';
  neu text := 'COALESCE(f.prozent_schwelle, 1200::numeric)';
begin
  if position(alt in d) = 0 then
    if position(neu in d) > 0 then raise notice 'api_abrechnung schon umgestellt'; return; end if;
    raise exception 'api_abrechnung: Stelle nicht gefunden – Ansicht wurde geändert, bitte von Hand prüfen';
  end if;
  execute 'create or replace view public.api_abrechnung with (security_invoker = true) as ' || replace(d, alt, neu);
end $$;
