-- Brute-force lockout for POST /auth/login, keyed by email - same shape and
-- same atomic-row-lock pattern as pin_lockouts/record_pin_lockout_failure
-- (20260730020000_pin_lockouts_table.sql), just keyed by the credential being
-- attacked (a user's email) instead of client IP, since each user now has
-- their own password rather than everyone sharing one PIN. The route also
-- carries a stricter slowapi rate limit as an IP-side backstop, since an
-- email-only lock would otherwise let anyone who knows a real address (e.g. a
-- public support inbox) lock that account out for free from any IP.
CREATE TABLE IF NOT EXISTS login_lockouts (
    email         TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL DEFAULT 0,
    first_fail_at TIMESTAMPTZ NOT NULL,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION record_login_lockout_failure(
    p_email TEXT,
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
    FROM login_lockouts WHERE email = p_email
    FOR UPDATE;

    IF v_fails IS NULL OR v_now - v_first_fail > (p_window_seconds || ' seconds')::INTERVAL THEN
        v_fails := 1;
        v_first_fail := v_now;
    ELSE
        v_fails := v_fails + 1;
    END IF;

    v_locked_until := CASE WHEN v_fails >= p_max_attempts
        THEN v_now + (p_window_seconds || ' seconds')::INTERVAL
        ELSE NULL END;

    INSERT INTO login_lockouts (email, fails, first_fail_at, locked_until, updated_at)
    VALUES (p_email, v_fails, v_first_fail, v_locked_until, v_now)
    ON CONFLICT (email) DO UPDATE SET
        fails = EXCLUDED.fails,
        first_fail_at = EXCLUDED.first_fail_at,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT v_locked_until;
END;
$$;
