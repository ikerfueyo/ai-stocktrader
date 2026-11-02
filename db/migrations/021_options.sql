-- Phase 9: options in the simulator. Option orders use sim_orders (OCC contract symbols, quantities in contracts); an mleg order is a
-- parent row (order_class mleg, its net limit price, positive a debit and negative a credit) with a row per leg (group_role leg,
-- ratio_qty contracts per unit). buying_power_held is what an option order holds back from buying power while open (its requirement
-- plus any debit), worked out when it's placed. Fees add the options regulatory fee (ORF) and the OCC clearing fee. Do-not-exercise
-- instructions keep a long contract from being exercised at expiration.
BEGIN;

ALTER TABLE sim_orders DROP CONSTRAINT IF EXISTS sim_orders_order_class_check;
ALTER TABLE sim_orders ADD CONSTRAINT sim_orders_order_class_check CHECK (order_class IN ('simple', 'bracket', 'oco', 'oto', 'mleg'));
ALTER TABLE sim_orders DROP CONSTRAINT IF EXISTS sim_orders_group_role_check;
ALTER TABLE sim_orders ADD CONSTRAINT sim_orders_group_role_check CHECK (group_role IN ('entry', 'take_profit', 'stop_loss', 'leg'));
ALTER TABLE sim_orders ADD COLUMN IF NOT EXISTS ratio_qty INTEGER;
ALTER TABLE sim_orders ADD COLUMN IF NOT EXISTS buying_power_held NUMERIC(14, 2);

ALTER TABLE sim_fee_accruals DROP CONSTRAINT IF EXISTS sim_fee_accruals_fee_type_check;
ALTER TABLE sim_fee_accruals ADD CONSTRAINT sim_fee_accruals_fee_type_check CHECK (fee_type IN ('REG', 'TAF', 'CAT', 'ORF', 'OCC'));

CREATE TABLE IF NOT EXISTS sim_option_instructions (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    symbol VARCHAR(32) NOT NULL,
    instruction VARCHAR(16) NOT NULL CHECK (instruction IN ('do_not_exercise')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, symbol)
);

COMMIT;
