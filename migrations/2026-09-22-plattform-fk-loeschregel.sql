-- bolt_drivers.fahrer_id und uber_drivers.fahrer_id zeigten ohne Loeschregel auf
-- fahrer(id). Loescht der bestehende n8n-Notion-Sync einen zugeordneten Fahrer,
-- haette die Fremdschluesselpruefung den Loeschvorgang blockiert - und damit den
-- Sync zum Scheitern gebracht.
--
-- Grundsatz: HYDRAlink darf den alten Weg niemals ausbremsen. Deshalb
-- on delete set null - das Plattform-Konto bleibt erhalten, verliert nur seine
-- Zuordnung und taucht danach als 'nicht zugeordnet' auf. Sichtbar statt kaputt.
alter table public.bolt_drivers drop constraint if exists bolt_drivers_fahrer_id_fkey;
alter table public.bolt_drivers
  add constraint bolt_drivers_fahrer_id_fkey
  foreign key (fahrer_id) references public.fahrer(id) on delete set null;

alter table public.uber_drivers drop constraint if exists uber_drivers_fahrer_id_fkey;
alter table public.uber_drivers
  add constraint uber_drivers_fahrer_id_fkey
  foreign key (fahrer_id) references public.fahrer(id) on delete set null;
