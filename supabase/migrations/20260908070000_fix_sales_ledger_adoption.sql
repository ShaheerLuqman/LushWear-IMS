-- 20260908060000's name-match adoption missed lushwear's existing "Sales
-- Revenue"/"Sales Return" ledgers (case/whitespace, or they already carried a
-- different system_key), so ensure_system_ledger fell through and created new
-- "Sales Revenue (2)" / "Sales Return (2)" system ledgers instead.
--
-- Move system_key onto the original ledger and delete the empty "(2)" one -
-- safe because it was only just created by that migration and has no journal
-- lines posted against it yet.
DO $$
DECLARE
    v_dup      RECORD;
    v_original UUID;
BEGIN
    FOR v_dup IN
        SELECT id, org_id, system_key,
               CASE system_key WHEN 'sales_revenue' THEN 'sales revenue' WHEN 'sales_return' THEN 'sales return' END AS base_name
          FROM finances_ledgers
         WHERE system_key IN ('sales_revenue', 'sales_return')
           AND name LIKE '% (2)'
    LOOP
        SELECT id INTO v_original FROM finances_ledgers
         WHERE org_id = v_dup.org_id
           AND lower(trim(name)) = v_dup.base_name
           AND id <> v_dup.id
         LIMIT 1;

        IF v_original IS NOT NULL THEN
            IF EXISTS (SELECT 1 FROM finances_journal_lines WHERE account_id = v_dup.id) THEN
                RAISE EXCEPTION 'Duplicate system ledger % has journal lines, refusing to drop', v_dup.id;
            END IF;

            UPDATE finances_ledgers SET system_key = NULL WHERE id = v_dup.id;
            DELETE FROM finances_ledgers WHERE id = v_dup.id;
            UPDATE finances_ledgers SET system_key = v_dup.system_key WHERE id = v_original;
        END IF;
    END LOOP;
END $$;
