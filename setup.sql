-- ============================================
-- HYDRALINK: App Users Setup
-- Dieses SQL im Supabase SQL Editor ausführen
-- ============================================

-- 1. Tabelle erstellen
CREATE TABLE IF NOT EXISTS app_users (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  pin text NOT NULL,
  role text DEFAULT 'user',
  created_at timestamptz DEFAULT now()
);

-- 2. User eintragen (PIN kannst du ändern)
INSERT INTO app_users (name, pin, role) VALUES
  ('Boyko', '1607', 'admin'),
  ('Bislan', '1607', 'user'),
  ('Musa', '1607', 'user')
ON CONFLICT (name) DO NOTHING;

-- 3. RLS aktivieren
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- 4. Anon darf lesen (für Login-Check)
CREATE POLICY "anon_can_read_users"
  ON app_users FOR SELECT
  TO anon
  USING (true);
