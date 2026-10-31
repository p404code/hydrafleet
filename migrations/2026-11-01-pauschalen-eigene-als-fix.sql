-- ============================================================================
-- Pauschalen: „eigene Regel“ landet in fahrer als mietmodell 'fix' mit eigenem Satz/Schwelle
-- Datum: 2026-11-01
--
-- Fehler: pauschale_setzen mit art 'eigene' schrieb fahrer.mietmodell = 'eigene' und scheiterte an
-- fahrer_mietmodell_check (nur fix/f11/f12). Ganzer Vorgang wurde zurückgerollt, nichts halb gespeichert.
-- Das alte System kennt die eigene Regel schon als „fix mit prozent_satz > 0“ (dritter Zweig im Bot,
-- api_abrechnung, prozent_nach_regel, Dashboard); pauschale_aus_fahrer übersetzt das zurück in 'eigene'.
-- Deshalb keine Änderung an der Prüfregel, nur an der Übersetzung Verlauf -> fahrer.
-- ============================================================================

create or replace function public.pauschale_spalten(p public.pauschalen,
  out mietmodell text, out basis_miete numeric, out prozent_satz numeric, out prozent_schwelle numeric)
language sql immutable set search_path = public as $$
  select case p.art when 'eigene' then 'fix' else p.art end, p.betrag,
         case p.art when 'f11' then 10 when 'f12' then 10 when 'eigene' then p.prozent_satz else 0 end,
         case p.art when 'f11' then 1100 when 'f12' then 1200 when 'eigene' then p.prozent_schwelle else 0 end
$$;
