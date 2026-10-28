-- Drops the app's mock ledger: orders, transactions and cash_activity, emptied by 013_accounts.sql and unused since the simulator took
-- over the ledger (Phase 3) and orders (Phase 4), and sim_activities.legacy_order_id, the mock order of a fill from before Phase 4.
-- Refuses to run while any of them still holds data.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM orders) OR EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM cash_activity)
        OR EXISTS (SELECT 1 FROM sim_activities WHERE legacy_order_id IS NOT NULL) THEN
        RAISE EXCEPTION 'The mock ledger still has rows; nothing was dropped';
    END IF;
END $$;

ALTER TABLE sim_activities DROP COLUMN legacy_order_id;
DROP TABLE transactions;
DROP TABLE cash_activity;
DROP TABLE orders;

COMMIT;
