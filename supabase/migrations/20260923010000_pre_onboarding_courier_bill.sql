-- Pre-onboarding courier bill, and the retirement of journal_orders_from.
-- See PRE_ONBOARDING_COURIER_PLAN.md.
--
-- The bill holds parcels already dispatched with the courier but not yet settled
-- at onboarding. It is an ordinary courier bill everywhere the Courier Payment
-- Report is concerned, and differs only in how it posts and in being exempt from
-- the org-wide sweeps that would otherwise reclaim its orders.
--
-- journal_orders_from goes at the end: it was the original, narrower cutover
-- ("orders dispatched before this post nothing, so a pre-cutover order that
-- settles after it cannot credit a courier receivable that was never debited" -
-- 20260910010000_sales_journal_posting.sql). onboarding_date now covers that and
-- more, and two gates that can disagree are worse than one.
ALTER TABLE shopify_courier_bills
    ADD COLUMN IF NOT EXISTS is_pre_onboarding BOOLEAN NOT NULL DEFAULT FALSE;

-- One pre-onboarding bill per courier per org.
CREATE UNIQUE INDEX IF NOT EXISTS idx_courier_bills_pre_onboarding
    ON shopify_courier_bills (org_id, courier) WHERE is_pre_onboarding;

-- The pre-onboarding bill is dated at the onboarding date, which collides with
-- the ordinary bill for parcels dispatched that same day - an org onboarding
-- today will have one. The (org_id, courier, pickup_date) uniqueness that
-- assign_courier_bills relies on therefore becomes partial: it governs ordinary
-- bills only, and the index above keeps pre-onboarding bills to one per courier.
ALTER TABLE shopify_courier_bills
    DROP CONSTRAINT IF EXISTS shopify_courier_bills_org_courier_pickup_key;

CREATE UNIQUE INDEX IF NOT EXISTS shopify_courier_bills_org_courier_pickup_key
    ON shopify_courier_bills (org_id, courier, pickup_date) WHERE NOT is_pre_onboarding;

-- A pre-onboarding bill posts the receivable and nothing else:
--
--   Dr <courier>                 SUM(total - advance)
--   Cr Opening Balance Equity    same
--
-- No Sales Revenue (that sale happened before onboarding, so its profit belongs
-- in opening equity rather than the first post-onboarding P&L) and no Orders leg
-- (those advances were collected pre-onboarding and sit in opening cash, not as
-- a liability to relieve). COGS/Inventory are not this function's business at
-- all - they moved to the period-level order_cogs_period posting.
--
-- The date gate is skipped for such a bill: it is dated at the onboarding date
-- by construction, and it is the one bill that must post despite holding
-- pre-cutover parcels.
CREATE OR REPLACE FUNCTION post_courier_bill_journal(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b         RECORD;
    v_found   BOOLEAN;
    v_from    DATE;
    v_total   NUMERIC(14, 2);
    v_advance NUMERIC(14, 2);
    v_lines   JSONB;
BEGIN
    SELECT * INTO b FROM shopify_courier_bills WHERE id = p_bill_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_bill_sale' AND source_id = p_bill_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT onboarding_date INTO v_from FROM system_organizations WHERE id = b.org_id;
    IF b.pickup_date < v_from AND NOT b.is_pre_onboarding THEN
        RETURN;
    END IF;

    SELECT ROUND(COALESCE(SUM(o.total_amount), 0), 2),
           ROUND(COALESCE(SUM(o.advance_amount), 0), 2)
      INTO v_total, v_advance
      FROM shopify_orders o
     WHERE o.courier_bill_id = p_bill_id
       AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled';

    IF b.is_pre_onboarding THEN
        v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                                v_total - v_advance, 'COD due from courier at onboarding');
        v_lines := journal_line(v_lines,
                                ensure_system_ledger(b.org_id, 'opening_balance_equity',
                                                     'Opening Balance Equity', 'Equity', '3000'),
                                -(v_total - v_advance), 'Pre-onboarding remaining orders');
    ELSE
        v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                                v_total - v_advance, 'COD due from courier');
        v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'orders', 'Orders', 'Liability', '2200'),
                                v_advance, 'Advances applied');
        v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000'),
                                -v_total, NULL);
    END IF;

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            b.org_id, b.pickup_date, v_lines,
            CASE WHEN b.is_pre_onboarding
                 THEN b.courier || ' pre-onboarding remaining orders'
                 ELSE b.courier || ' dispatch ' || to_char(b.pickup_date, 'DD Mon YYYY') END,
            'sale', NULL::UUID, 'courier_bill_sale', b.id
        );
    END IF;
END;
$$;

-- assign_courier_bills groups orders onto the bill matching their own
-- (courier, pickup_date). The pre-onboarding bill is dated at the onboarding
-- date while its members were picked up earlier, so without an exemption the
-- next sync would move every order out of it, empty it, and zero its posting.
--
-- It already leaves settled bills alone; pre-onboarding bills join them. Reusing
-- the 'settled' status for this instead would wrongly assert the orders had been
-- paid. The empty-bill cleanup is exempted too, or a rebuild - which detaches
-- members before re-classifying - would delete the bill mid-flight.
CREATE OR REPLACE FUNCTION assign_courier_bills(
    p_org_id UUID,
    p_order_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(assigned INTEGER, blocked UUID[])
LANGUAGE plpgsql
AS $$
DECLARE
    v_assigned INTEGER := 0;
    v_blocked UUID[];
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS _candidates (
        id UUID,
        courier VARCHAR(100),
        pickup_date DATE,
        current_bill_id UUID
    ) ON COMMIT DROP;
    TRUNCATE _candidates;

    INSERT INTO _candidates (id, courier, pickup_date, current_bill_id)
    SELECT o.id,
           COALESCE(NULLIF(BTRIM(o.courier), ''), 'Unknown'),
           (o.courier_pickup_date AT TIME ZONE 'Asia/Karachi')::DATE,
           o.courier_bill_id
      FROM shopify_orders o
     WHERE o.org_id = p_org_id
       AND o.courier_pickup_date IS NOT NULL
       AND (p_order_ids IS NULL OR o.id = ANY(p_order_ids));

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND b.courier = c.courier
       AND b.pickup_date = c.pickup_date;

    SELECT COALESCE(ARRAY_AGG(c.id), '{}')
      INTO v_blocked
      FROM _candidates c
      JOIN shopify_courier_bills b ON b.id = c.current_bill_id
     WHERE b.status = 'settled' OR b.is_pre_onboarding;

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND (b.status = 'settled' OR b.is_pre_onboarding);

    INSERT INTO shopify_courier_bills (org_id, courier, pickup_date)
    SELECT DISTINCT p_org_id, c.courier, c.pickup_date FROM _candidates c
    -- Matches the partial index above; without the predicate Postgres cannot
    -- infer which unique index this conflict target refers to.
    ON CONFLICT (org_id, courier, pickup_date) WHERE NOT is_pre_onboarding DO NOTHING;

    WITH updated AS (
        UPDATE shopify_orders o
           SET courier_bill_id = b.id,
               updated_at = NOW()
          FROM _candidates c
          JOIN shopify_courier_bills b
            ON b.org_id = p_org_id
           AND b.courier = c.courier
           AND b.pickup_date = c.pickup_date
           -- The pre-onboarding bill shares its date with the ordinary bill for
           -- parcels dispatched on the onboarding day; without this the join
           -- matches both and the assignment is ambiguous.
           AND NOT b.is_pre_onboarding
         WHERE o.id = c.id
           AND o.org_id = p_org_id
        RETURNING o.id
    )
    SELECT COUNT(*)::INTEGER INTO v_assigned FROM updated;

    DELETE FROM shopify_courier_bills b
     WHERE b.org_id = p_org_id
       AND b.status = 'open'
       AND NOT b.is_pre_onboarding
       AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.courier_bill_id = b.id);

    RETURN QUERY SELECT v_assigned, COALESCE(v_blocked, '{}');
END;
$$;

-- assign_courier_payouts is org-wide, not scoped to the upload that calls it: it
-- creates a payout row for every settled order carrying a folio. A payout dated
-- before onboarding can post nothing (the cutoff trigger drops its voucher), so
-- it would exist as a row with no accounting behind it - exactly the unexplained
-- money this design avoids. Filtering on the payout's own derived date covers
-- CSV-settled orders too, which stay on their original pickup-date bills and so
-- are not reachable through is_pre_onboarding.
CREATE OR REPLACE FUNCTION assign_courier_payouts(p_org_id UUID, p_cash_ledger_id UUID DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_n          INT;
    v_new_ids    UUID[];
    v_onboarding DATE;
BEGIN
    SELECT onboarding_date INTO v_onboarding FROM system_organizations WHERE id = p_org_id;

    WITH inserted AS (
        INSERT INTO finances_courier_payouts (org_id, courier, folio, payout_date)
        SELECT p_org_id,
               o.courier,
               normalize_folio(o.folio),
               -- A folio that does not parse still has to sit somewhere on the calendar;
               -- the last dispatch it covers is the earliest date it can honestly be.
               COALESCE(folio_payout_date(o.folio),
                        MAX(COALESCE(o.courier_pickup_date, o.fulfilled_at))::DATE)
          FROM shopify_orders o
         WHERE o.org_id = p_org_id
           AND o.is_order_settled
           AND COALESCE(trim(o.folio), '') <> ''
           AND COALESCE(o.courier_pickup_date, o.fulfilled_at) IS NOT NULL
         GROUP BY o.courier, normalize_folio(o.folio), folio_payout_date(o.folio)
        HAVING v_onboarding IS NULL
            OR COALESCE(folio_payout_date(o.folio),
                        MAX(COALESCE(o.courier_pickup_date, o.fulfilled_at))::DATE) >= v_onboarding
            ON CONFLICT (org_id, courier, folio) DO NOTHING
        RETURNING id
    )
    SELECT array_agg(id) INTO v_new_ids FROM inserted;

    IF p_cash_ledger_id IS NOT NULL AND v_new_ids IS NOT NULL THEN
        UPDATE finances_courier_payouts
           SET cash_ledger_id = p_cash_ledger_id
         WHERE id = ANY(v_new_ids);
    END IF;

    UPDATE shopify_orders o
       SET courier_payout_id = y.id
      FROM finances_courier_payouts y
     WHERE o.org_id = p_org_id
       AND y.org_id = p_org_id
       AND o.is_order_settled
       AND y.courier = o.courier
       AND y.folio = normalize_folio(o.folio)
       AND o.courier_payout_id IS DISTINCT FROM y.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN v_n;
END;
$$;

-- Two changes for pre-onboarding members, both because the pre-onboarding bill
-- now puts real COD on the courier account for parcels dispatched before the
-- cutover:
--
-- 1. They must be included. The member filter drops parcels dispatched before
--    the cutover on the grounds that they have "no COD on the courier account to
--    clear" - true for every other bill, false for this one. Without this the
--    receivable the pre-onboarding bill created would never clear.
-- 2. Their returns post to Opening Balance Equity, not Sales Return. Their sale
--    was never recognised as revenue, so unwinding it through Sales Return would
--    show a return with no matching sale in the first post-onboarding P&L.
--
-- Delivery charges and withholding tax stay expenses even for these parcels:
-- they are deductions the org first learns about when the CPR arrives.
CREATE OR REPLACE FUNCTION post_courier_payout_journal(p_payout_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    p          RECORD;
    v_found    BOOLEAN;
    v_from     DATE;
    v_cod      NUMERIC(14, 2);
    v_ret_net  NUMERIC(14, 2);
    v_ret_pre  NUMERIC(14, 2);
    v_charge   NUMERIC(14, 2);
    v_tax      NUMERIC(14, 2);
    v_cash     UUID;
    v_courier  UUID;
    v_cash_net NUMERIC(14, 2);
    v_lines    JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_id = p_payout_id
       AND source_type IN ('courier_payout', 'courier_payout_return',
                            'courier_payout_delivery_charge', 'courier_payout_tax',
                            'courier_payout_cash');
    -- Cascades to the journal entry it projected, via transaction_entries_journal_trigger.
    DELETE FROM finances_transaction_entries
     WHERE source_id = p_payout_id AND source_type = 'courier_payout_cash';

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT onboarding_date INTO v_from FROM system_organizations WHERE id = p.org_id;

    SELECT
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'delivered'), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'
                                 AND NOT COALESCE(cb.is_pre_onboarding, FALSE)), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'
                                 AND COALESCE(cb.is_pre_onboarding, FALSE)), 0), 2),
        ROUND(COALESCE(SUM(o.delivery_charge), 0), 2),
        ROUND(COALESCE(SUM(o.tax_amount), 0), 2)
      INTO v_cod, v_ret_net, v_ret_pre, v_charge, v_tax
      FROM shopify_orders o
      LEFT JOIN shopify_courier_bills cb ON cb.id = o.courier_bill_id
     WHERE o.courier_payout_id = p_payout_id
       AND (COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_from
            OR COALESCE(cb.is_pre_onboarding, FALSE));

    v_cash    := COALESCE(p.cash_ledger_id, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE));
    v_courier := resolve_courier_ledger(p.org_id, p.courier);

    -- Returns: Dr Sales Return (or Opening Balance Equity, for parcels whose sale
    -- was never recognised) / Cr courier.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_ret_net, 'Returned parcels');
    v_lines := journal_line(v_lines,
                            ensure_system_ledger(p.org_id, 'opening_balance_equity',
                                                 'Opening Balance Equity', 'Equity', '3000'),
                            v_ret_pre, 'Returned pre-onboarding parcels');
    v_lines := journal_line(v_lines, v_courier, -(v_ret_net + v_ret_pre), 'Returns Adjustment');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Returns',
            'return', NULL::UUID, 'courier_payout_return', p.id
        );
    END IF;

    -- Delivery Charges: Dr Delivery Charges / Cr courier.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, NULL);
    v_lines := journal_line(v_lines, v_courier, -v_charge, 'Delivery charges deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Delivery Charges',
            'journal', NULL::UUID, 'courier_payout_delivery_charge', p.id
        );
    END IF;

    -- Withholding Tax: Dr Withholding Tax / Cr courier.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, NULL);
    v_lines := journal_line(v_lines, v_courier, -v_tax, 'Withholding tax deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Withholding Tax',
            'journal', NULL::UUID, 'courier_payout_tax', p.id
        );
    END IF;

    -- Cash: Dr <received-in ledger> / Cr courier - the actual net cash received,
    -- matching the CSV's own NET_AMOUNT total. Posted as a transaction entry (not
    -- a direct post_journal_entry call) so it also lands on the Transactions page,
    -- like any other cash movement - see project_transaction_entry_to_journal.
    v_cash_net := v_cod - v_charge - v_tax;
    IF v_cash_net <> 0 THEN
        INSERT INTO finances_transaction_entries
            (org_id, entry_date, amount, description, from_account_id, to_account_id, source_type, source_id)
        VALUES (
            p.org_id, p.payout_date, ABS(v_cash_net),
            p.courier || ' payout ' || p.folio || ' - Cash Received',
            CASE WHEN v_cash_net > 0 THEN v_courier ELSE v_cash    END,
            CASE WHEN v_cash_net > 0 THEN v_cash    ELSE v_courier END,
            'courier_payout_cash', p.id
        );
    END IF;
END;
$$;

-- Accretion: a parcel dispatched before onboarding that was left off the bill
-- (outside the 60-day window, so presumed uncollectible) joins it the moment a
-- CPR proves otherwise. Its cash is real, so it needs a receivable to clear -
-- otherwise post_courier_payout_journal's member filter drops it and the CSV's
-- NET_AMOUNT lands in the bank while the voucher records less.
--
-- Called by the CPR upload after bill assignment and before payouts are posted,
-- so the receivable exists before the voucher that clears it.
CREATE OR REPLACE FUNCTION sync_pre_onboarding_bill(p_org_id UUID, p_courier VARCHAR)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_onboarding DATE;
    v_bill       UUID;
    v_n          INT := 0;
BEGIN
    SELECT onboarding_date INTO v_onboarding FROM system_organizations WHERE id = p_org_id;
    IF v_onboarding IS NULL THEN
        RETURN 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM shopify_orders o
          LEFT JOIN shopify_courier_bills b ON b.id = o.courier_bill_id
         WHERE o.org_id = p_org_id
           AND o.courier = p_courier
           AND o.is_order_settled
           AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE < v_onboarding
           AND NOT COALESCE(b.is_pre_onboarding, FALSE)
    ) THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_bill
      FROM shopify_courier_bills
     WHERE org_id = p_org_id AND courier = p_courier AND is_pre_onboarding;

    IF v_bill IS NULL THEN
        INSERT INTO shopify_courier_bills (org_id, courier, pickup_date, is_pre_onboarding, notes)
        VALUES (p_org_id, p_courier, v_onboarding, TRUE, 'Pre-onboarding remaining orders')
        RETURNING id INTO v_bill;
    END IF;

    WITH moved AS (
        UPDATE shopify_orders o
           SET courier_bill_id = v_bill,
               updated_at = NOW()
          FROM (
              SELECT o2.id
                FROM shopify_orders o2
                LEFT JOIN shopify_courier_bills b ON b.id = o2.courier_bill_id
               WHERE o2.org_id = p_org_id
                 AND o2.courier = p_courier
                 AND o2.is_order_settled
                 AND COALESCE(o2.courier_pickup_date, o2.fulfilled_at)::DATE < v_onboarding
                 AND NOT COALESCE(b.is_pre_onboarding, FALSE)
          ) stale
         WHERE o.id = stale.id
        RETURNING o.id
    )
    SELECT COUNT(*)::INT INTO v_n FROM moved;

    PERFORM post_courier_bill_journal(v_bill);
    RETURN v_n;
END;
$$;

ALTER TABLE system_organizations DROP COLUMN IF EXISTS journal_orders_from;
