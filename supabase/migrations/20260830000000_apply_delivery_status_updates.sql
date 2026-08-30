-- Bulk delivery-status writeback for the tracking fetch (orders.py's
-- _save_delivery_status_updates). Previously that saved one order per UPDATE, each on its
-- own freshly-constructed Supabase client, so refreshing N orders cost N clients and N
-- round-trips; this collapses the whole batch into one call.
--
-- Deliberately an UPDATE ... FROM rather than a bulk upsert: shopify_orders has NOT NULL
-- columns and hand-edited ones (cost_price, folio, is_order_settled, ...) that an
-- INSERT ... ON CONFLICT would reset to defaults for every column absent from the payload.
-- Each field below is applied only when the caller actually supplies it, so a stale
-- in-memory snapshot still can't clobber a field someone else edited meanwhile - the same
-- partial-write guarantee the per-row UPDATEs gave.
--
-- p_updates is a JSONB array of objects:
--   { id, delivery_status, courier_pickup_date?, order_status?, piece_received? }
-- Returns the ids actually written, so the caller can tell which rows matched.

CREATE OR REPLACE FUNCTION apply_delivery_status_updates(
    p_org_id UUID,
    p_updates JSONB
)
RETURNS TABLE(id UUID)
LANGUAGE sql
AS $$
    UPDATE shopify_orders o
       SET delivery_status = u.delivery_status,
           -- COALESCE keeps the existing value when the key is absent/null, so an order
           -- whose courier reported no pickup date or no mappable status is left alone
           -- rather than being blanked.
           courier_pickup_date = COALESCE(u.courier_pickup_date, o.courier_pickup_date),
           order_status        = COALESCE(u.order_status, o.order_status),
           piece_received      = COALESCE(u.piece_received, o.piece_received),
           updated_at          = NOW()
      FROM jsonb_to_recordset(p_updates) AS u(
           id UUID,
           delivery_status JSONB,
           courier_pickup_date TIMESTAMPTZ,
           order_status VARCHAR(50),
           piece_received TEXT
       )
     WHERE o.id = u.id
       -- Scoped to the caller's org here, not just in Python: this function is reachable
       -- over PostgREST, and org_table() cannot constrain an rpc() call the way it does a
       -- table query.
       AND o.org_id = p_org_id
    RETURNING o.id;
$$;
