-- Let the "amount received" leg of a PostEx payout voucher post to a ledger the
-- user picks (an org with more than one bank account, or that wants this kept
-- out of generic Cash-in-Hand) instead of always the seeded `cash` system ledger.
--
-- Stored on the payout row itself, not only threaded through as a call argument -
-- a payout is created once per (courier, folio) and posted/reposted many times
-- (a duplicate upload, the org-wide backfill loop), and each of those needs to
-- reuse the same ledger the first upload picked rather than silently falling back
-- to plain Cash and splitting one real deposit across two ledgers.
ALTER TABLE finances_courier_payouts
    ADD COLUMN IF NOT EXISTS cash_ledger_id UUID REFERENCES finances_ledgers(id);

CREATE OR REPLACE FUNCTION post_courier_payout_journal(p_payout_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    p          RECORD;
    v_found    BOOLEAN;
    v_from     DATE;
    v_cod      NUMERIC(14, 2);
    v_ret_cod  NUMERIC(14, 2);
    v_ret_tot  NUMERIC(14, 2);
    v_ret_adv  NUMERIC(14, 2);
    v_charge   NUMERIC(14, 2);
    v_tax      NUMERIC(14, 2);
    v_cash     UUID;
    v_lines    JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_payout' AND source_id = p_payout_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT journal_orders_from INTO v_from FROM system_organizations WHERE id = p.org_id;

    SELECT
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'delivered'), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.total_amount) FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.advance_amount) FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.delivery_charge), 0), 2),
        ROUND(COALESCE(SUM(o.tax_amount), 0), 2)
      INTO v_cod, v_ret_cod, v_ret_tot, v_ret_adv, v_charge, v_tax
      FROM shopify_orders o
     WHERE o.courier_payout_id = p_payout_id
       -- A member whose bill was never posted (dispatched before the cutover) has no
       -- COD on the courier account to clear.
       AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_from;

    v_cash := COALESCE(p.cash_ledger_id, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE));

    v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(p.org_id, p.courier),
                            -(v_cod + v_ret_cod), 'COD cleared');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_ret_tot, 'Returned parcels');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'orders', 'Orders', 'Liability', '2200'),
                            -v_ret_adv, 'Advances refundable');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, NULL);
    v_lines := journal_line(v_lines, v_cash, v_cod - v_charge - v_tax, 'Payout received');

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio, 'receipt', NULL::UUID, 'courier_payout', p.id
        );
    END IF;
END;
$$;

-- Group settled orders into the CPR that paid them, as before, but now
-- optionally stamping the ledger this upload chose onto any payout row this
-- specific call creates. A payout the INSERT skips via ON CONFLICT (already
-- existing from an earlier upload of the same folio) is never in v_new_ids,
-- so re-uploading the same CPR - with or without repicking a ledger - leaves
-- its stored cash_ledger_id exactly as the first upload set it.
CREATE OR REPLACE FUNCTION assign_courier_payouts(p_org_id UUID, p_cash_ledger_id UUID DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_n        INT;
    v_new_ids  UUID[];
BEGIN
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
