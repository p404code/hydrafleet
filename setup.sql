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

-- ============================================
-- CUSTOMERS (Rechnungsempfaenger) Setup
-- ============================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  uid TEXT DEFAULT '',
  color_scheme TEXT DEFAULT 'grau',
  is_default BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 99,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_customers" ON customers FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_customers" ON customers FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_delete_customers" ON customers FOR DELETE TO anon USING (true);
CREATE POLICY "anon_update_customers" ON customers FOR UPDATE TO anon USING (true);

-- ============================================
-- NAME_ALIASES (CSV-Name → Fahrer Zuordnung)
-- ============================================

CREATE TABLE IF NOT EXISTS name_aliases (
  csv_name TEXT PRIMARY KEY,
  fahrer_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE name_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_aliases" ON name_aliases FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_aliases" ON name_aliases FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_aliases" ON name_aliases FOR UPDATE TO anon USING (true);
CREATE POLICY "anon_delete_aliases" ON name_aliases FOR DELETE TO anon USING (true);
