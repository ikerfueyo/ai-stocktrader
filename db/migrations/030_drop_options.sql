-- Drops what options (021_options.sql, 013_accounts.sql) left behind, unused since 026_no_options.sql: the approval requests, the
-- do-not-exercise instructions, the account's approved level, the mleg order class with its legs' ratio_qty, and what option orders
-- held from buying power. It refuses to run while a multi-leg order is stored, since its legs would lose their ratios. Single-leg
-- option fills and their ORF and OCC fees stay in the ledger as history.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM sim_orders WHERE order_class = 'mleg' OR group_role = 'leg') THEN
        RAISE EXCEPTION 'Multi-leg option orders are still stored: delete them before dropping the options columns';
    END IF;
END $$;

ALTER TABLE sim_orders DROP CONSTRAINT IF EXISTS sim_orders_order_class_check;
ALTER TABLE sim_orders ADD CONSTRAINT sim_orders_order_class_check CHECK (order_class IN ('simple', 'bracket', 'oco', 'oto'));
ALTER TABLE sim_orders DROP CONSTRAINT IF EXISTS sim_orders_group_role_check;
ALTER TABLE sim_orders ADD CONSTRAINT sim_orders_group_role_check CHECK (group_role IN ('entry', 'take_profit', 'stop_loss'));
ALTER TABLE sim_orders DROP COLUMN IF EXISTS ratio_qty;
ALTER TABLE sim_orders DROP COLUMN IF EXISTS buying_power_held;

ALTER TABLE sim_accounts DROP COLUMN IF EXISTS options_approved_level;

DROP TABLE IF EXISTS sim_option_instructions;
DROP TABLE IF EXISTS sim_options_approvals;

COMMIT;
