-- ============================================
-- KASSIER_ZAHLUNGEN: collected payments per driver debt
-- Spec: docs/superpowers/specs/2026-05-21-muessen-zahlen-tab-design.md
-- ============================================

CREATE TABLE IF NOT EXISTS kassier_zahlungen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fahrer_name TEXT NOT NULL,
  woche TEXT NOT NULL,
  betrag NUMERIC(10,2) NOT NULL CHECK (betrag > 0),
  typ TEXT NOT NULL CHECK (typ IN ('bar', 'ueberweisung', 'verrechnet')),
  verrechnet_mit_woche TEXT,
  kassiert_von TEXT NOT NULL,
  kassiert_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  CONSTRAINT verrechnet_requires_woche
    CHECK (typ <> 'verrechnet' OR verrechnet_mit_woche IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_kassier_fahrer_woche
  ON kassier_zahlungen (fahrer_name, woche);

ALTER TABLE kassier_zahlungen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_kassier" ON kassier_zahlungen
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_insert_kassier" ON kassier_zahlungen
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_delete_kassier" ON kassier_zahlungen
  FOR DELETE TO anon USING (true);

-- No UPDATE policy: errors are corrected via delete + re-insert (admin only client-side)
