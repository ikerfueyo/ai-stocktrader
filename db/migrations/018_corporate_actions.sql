-- Phase 6: corporate actions beyond splits and cash dividends. Stock dividends, cash, stock and mixed (stock and cash) mergers,
-- spinoffs, symbol changes and worthless removals (from Alpaca's corporate actions API when keys are set) are stored with the rest;
-- each is applied to accounts once (sim_corporate_actions_applied) and adjusts or cancels open orders once
-- (sim_corporate_action_orders).
BEGIN;

ALTER TABLE corporate_actions DROP CONSTRAINT IF EXISTS corporate_actions_type_check;
ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_type_check CHECK ("type" IN (
    'SPLIT', 'DIVIDEND', 'STOCK_DIVIDEND', 'CASH_MERGER', 'STOCK_MERGER', 'MIXED_MERGER', 'SPINOFF', 'NAME_CHANGE', 'WORTHLESS'
));
-- The symbol it leads to (the acquirer, the spun-off company, the new symbol), and where it came from
ALTER TABLE corporate_actions ADD COLUMN IF NOT EXISTS new_ticker VARCHAR(32);
ALTER TABLE corporate_actions ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'alphavantage';

ALTER TABLE sim_corporate_actions_applied DROP CONSTRAINT IF EXISTS sim_corporate_actions_applied_type_check;
ALTER TABLE sim_corporate_actions_applied ADD CONSTRAINT sim_corporate_actions_applied_type_check CHECK ("type" IN (
    'SPLIT', 'DIVIDEND', 'STOCK_DIVIDEND', 'CASH_MERGER', 'STOCK_MERGER', 'MIXED_MERGER', 'SPINOFF', 'NAME_CHANGE', 'WORTHLESS'
));

CREATE TABLE IF NOT EXISTS sim_corporate_action_orders (
    ticker VARCHAR(255) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    ex_date DATE NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, "type", ex_date)
);

COMMIT;
