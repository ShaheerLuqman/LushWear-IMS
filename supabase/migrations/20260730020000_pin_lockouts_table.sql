-- Externalizes the app-PIN brute-force lockout (routes/app_pin.py) from an
-- in-memory, per-process dict to Supabase, so it survives restarts/redeploys
-- and works across replicas - the in-memory version reset on every deploy and
-- gave each instance its own independent counter.
CREATE TABLE IF NOT EXISTS pin_lockouts (
    client_key    TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL DEFAULT 0,
    first_fail_at TIMESTAMPTZ NOT NULL,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomically records one failed /verify attempt for p_client_key and returns the
-- resulting lockout expiry (NULL if not locked). Row-locked via SELECT ... FOR
-- UPDATE so concurrent failed attempts from the same key can't race past
-- p_max_attempts - the in-memory version had a threading.Lock for the same reason.
CREATE OR REPLACE FUNCTION record_pin_lockout_failure(
    p_client_key TEXT,
    p_max_attempts INT,
    p_window_seconds INT
)
RETURNS TABLE(locked_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_fails INT;
    v_first_fail TIMESTAMPTZ;
    v_locked_until TIMESTAMPTZ;
BEGIN
    SELECT fails, first_fail_at INTO v_fails, v_first_fail
    FROM pin_lockouts WHERE client_key = p_client_key
    FOR UPDATE;

    -- No row yet, or the previous failure window has already expired: start a
    -- fresh window instead of accumulating against a stale count.
    IF v_fails IS NULL OR v_now - v_first_fail > (p_window_seconds || ' seconds')::INTERVAL THEN
        v_fails := 1;
        v_first_fail := v_now;
    ELSE
        v_fails := v_fails + 1;
    END IF;

    v_locked_until := CASE WHEN v_fails >= p_max_attempts
        THEN v_now + (p_window_seconds || ' seconds')::INTERVAL
        ELSE NULL END;

    INSERT INTO pin_lockouts (client_key, fails, first_fail_at, locked_until, updated_at)
    VALUES (p_client_key, v_fails, v_first_fail, v_locked_until, v_now)
    ON CONFLICT (client_key) DO UPDATE SET
        fails = EXCLUDED.fails,
        first_fail_at = EXCLUDED.first_fail_at,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT v_locked_until;
END;
$$;
