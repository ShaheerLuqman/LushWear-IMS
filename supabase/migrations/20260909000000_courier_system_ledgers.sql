-- A courier enabled in Settings > Couriers gets a system ledger
-- (finances_ledgers.system_key = 'courier_<id>') - an Asset account for the COD a
-- courier is holding on our behalf. Called from app/couriers.py when a courier is
-- toggled on.
--
-- Adopt-or-create, like the one-time "Orders" adoption in
-- 20260801150000_system_ledgers_on_org_creation.sql, but as a runtime function:
-- an org that already keeps a plain ledger named "PostEx"/"TCS"/etc. keeps that
-- account (and its history) rather than getting a second, empty one. Name
-- matching is safe here for the same reason it was there - a one-shot adoption,
-- not a runtime classifier - and idx_ledgers_org_system_key still guarantees one
-- ledger per role afterwards.

CREATE OR REPLACE FUNCTION enable_courier_system_ledger(
    p_org_id     UUID,
    p_system_key VARCHAR,
    p_name       VARCHAR,
    p_code       VARCHAR
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
BEGIN
    SELECT id INTO v_id
      FROM finances_ledgers
     WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    SELECT id INTO v_id
      FROM finances_ledgers
     WHERE org_id = p_org_id
       AND system_key IS NULL
       AND lower(trim(name)) = lower(trim(p_name))
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        UPDATE finances_ledgers SET system_key = p_system_key WHERE id = v_id;
        RETURN v_id;
    END IF;

    RETURN ensure_system_ledger(p_org_id, p_system_key, p_name, 'Asset', p_code);
END;
$$;
