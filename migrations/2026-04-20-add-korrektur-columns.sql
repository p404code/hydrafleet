-- ============================================
-- KW17-Korrektur: Add korrektur + korrektur_note to settlements
-- Date: 2026-04-20
-- Reason: KW16/2026 falsche CSV hochgeladen, Korrektur in KW17
-- Rollback: ALTER TABLE settlements DROP COLUMN korrektur, DROP COLUMN korrektur_note;
-- ============================================

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS korrektur NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS korrektur_note TEXT;

-- Sanity-Check
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'settlements'
  AND column_name IN ('korrektur', 'korrektur_note');
