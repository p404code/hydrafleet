-- Themen fuer alle Fahrer wieder abgeschaltet (Betreiber 26.10.2026: "zu viele offene Fahrer, muessen alle weg").
-- Am 26.10. von Hand ausgefuehrt; die 6 vom Lauf angelegten, leeren Themen wurden in Telegram und in tg_themen geloescht.
-- Themen entstehen wieder nur, wenn ein Fahrer schreibt. tg_fahrer_liste() bleibt (Suche, Nachricht an alle).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'themen-pflegen') then
    perform cron.unschedule('themen-pflegen');
  end if;
end $$;
