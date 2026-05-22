-- ============================================
-- KASSIER_ZAHLUNGEN: enforce admin-only DELETE serverside
--
-- Previous state (siehe 2026-05-22-add-kassier-zahlungen.sql):
--   Policy "anon_delete_kassier" allowed any anon-key client to DELETE.
--   Admin check lived only in dashboard.html — bypassable via console
--   or curl by anyone in possession of the public anon key.
--
-- New state:
--   - DROP the open anon DELETE policy.
--   - Provide a SECURITY DEFINER RPC that verifies the caller is the
--     admin user identified by (name + pin + role='admin'). Identity by
--     name+pin together is required because PINs are reused across
--     users (e.g. Boyko/Adam both have '1607') — pin alone is not
--     distinguishing.
-- ============================================

DROP POLICY IF EXISTS "anon_delete_kassier" ON kassier_zahlungen;

CREATE OR REPLACE FUNCTION delete_kassier_admin(p_id uuid, p_name text, p_pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_users
    WHERE name = p_name
      AND pin = p_pin
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Nicht autorisiert' USING ERRCODE = '42501';
  END IF;
  DELETE FROM kassier_zahlungen WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_kassier_admin(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_kassier_admin(uuid, text, text) TO anon;
