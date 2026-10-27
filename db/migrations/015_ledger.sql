-- The simulator's ledger (Phase 3 of docs/brokerage-roadmap.md): trade fills join the account's activities, open positions are
-- FIFO tax lots, regulatory fees accrue with each fill and are deducted at the end of the day, splits and dividends post per
-- account, and each trading day's closing balances are kept. Nothing is dropped: the mock ledger's transactions and cash_activity
-- tables are no longer read or written.

-- A FILL activity's fields (Alpaca's TradeActivity), the P&L it realized against the lots it closed, its settlement date (T+1),
-- the quote it filled against, and, until orders move to the simulator (Phase 4), the mock order it filled
ALTER TABLE sim_activities
    ADD COLUMN side VARCHAR(4) CHECK (side IN ('buy', 'sell')),
    ADD COLUMN price NUMERIC(18, 6),
    ADD COLUMN leaves_qty NUMERIC(18, 9),
    ADD COLUMN cum_qty NUMERIC(18, 9),
    ADD COLUMN realized_pl NUMERIC(14, 2),
    ADD COLUMN settle_date DATE,
    ADD COLUMN reason VARCHAR(32),
    ADD COLUMN quote_time TIMESTAMPTZ,
    ADD COLUMN fill_policy VARCHAR(16),
    ADD COLUMN legacy_order_id INTEGER REFERENCES orders(id);
CREATE INDEX sim_activities_type_idx ON sim_activities (account_id, activity_type, symbol, created_at);

-- Tax lots: shares bought (long) or sold short (short) together. qty is what's still open (0 once closed); original_qty, price and
-- acquired_at are split-adjusted. wash_sale_adjustment is added to the basis by a disallowed loss (Phase 7).
CREATE TABLE sim_lots (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(5) NOT NULL CHECK (side IN ('long', 'short')),
    qty NUMERIC(18, 9) NOT NULL CHECK (qty >= 0),
    original_qty NUMERIC(18, 9) NOT NULL,
    price NUMERIC(18, 8) NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    fill_id VARCHAR(64) NOT NULL REFERENCES sim_activities(id),
    wash_sale_adjustment NUMERIC(14, 2) NOT NULL DEFAULT 0
);
CREATE INDEX sim_lots_open_idx ON sim_lots (account_id, symbol, acquired_at) WHERE qty > 0;

-- What each fill closed of each lot, for realized gains by lot and holding period
CREATE TABLE sim_lot_closings (
    id SERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    lot_id UUID NOT NULL REFERENCES sim_lots(id),
    fill_id VARCHAR(64) NOT NULL REFERENCES sim_activities(id),
    qty NUMERIC(18, 9) NOT NULL,
    lot_price NUMERIC(18, 8) NOT NULL,
    close_price NUMERIC(18, 6) NOT NULL,
    realized NUMERIC(14, 2) NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sim_lot_closings_account_idx ON sim_lot_closings (account_id, closed_at);

-- Regulatory fees accrued by fills (REG SEC fee, TAF, CAT), unrounded, until the end-of-day job deducts them (deducted_by, the FEE
-- activity)
CREATE TABLE sim_fee_accruals (
    id SERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    fee_type VARCHAR(4) NOT NULL CHECK (fee_type IN ('REG', 'TAF', 'CAT')),
    amount NUMERIC(18, 8) NOT NULL,
    fill_id VARCHAR(64) NOT NULL REFERENCES sim_activities(id),
    deducted_by VARCHAR(64) REFERENCES sim_activities(id)
);
CREATE INDEX sim_fee_accruals_open_idx ON sim_fee_accruals (account_id, "date") WHERE deducted_by IS NULL;

-- The splits and dividends already applied to each account, so each is applied once
CREATE TABLE sim_corporate_actions_applied (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    symbol VARCHAR(32) NOT NULL,
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPLIT', 'DIVIDEND')),
    ex_date DATE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, symbol, "type", ex_date)
);

-- Each trading day's closing balances (the end-of-day job), for last_equity and the other last_* figures
CREATE TABLE sim_daily_balances (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    equity NUMERIC(16, 2) NOT NULL,
    cash NUMERIC(16, 2) NOT NULL,
    long_market_value NUMERIC(16, 2) NOT NULL,
    short_market_value NUMERIC(16, 2) NOT NULL,
    maintenance_margin NUMERIC(16, 2) NOT NULL,
    PRIMARY KEY (account_id, "date")
);
