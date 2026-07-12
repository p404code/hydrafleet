-- Lohn als Durchlaufposten pro Abrechnung (fahrer_name + woche).
-- Roh gespeichert; Netto-Auszahlung wird im Frontend berechnet (auszahlung - lohn).
-- Der bestehende auszahlung-Wert bleibt unveraendert -> "Muessen zahlen" & AbrechnungsBot unberuehrt.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS lohn numeric DEFAULT 0;
