-- Phase 5: margin, shorting and calls in the simulator. Margin calls, margin interest accruals, hard-to-borrow fees and locates;
-- liquidation orders are marked; the daily balances keep the margin figures for the trading account's last_* fields.
BEGIN;

ALTER TABLE sim_orders ADD COLUMN IF NOT EXISTS liquidation BOOLEAN NOT NULL DEFAULT false;

-- A call for an end-of-day deficiency: issued the next morning, due by due_at, then met (the deficiency is gone or deposits covered
-- it) or liquidated
CREATE TABLE IF NOT EXISTS sim_margin_calls (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "type" VARCHAR(12) NOT NULL CHECK ("type" IN ('maintenance', 'regt')),
    amount NUMERIC(16, 2) NOT NULL,
    -- The trading day whose close it was found at
    "date" DATE NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'liquidated')),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sim_margin_calls_account_idx ON sim_margin_calls (account_id, status);

-- Margin interest accrued at each end of day on the settlement-date debit balance, posted at month end as an INT activity
CREATE TABLE IF NOT EXISTS sim_interest_accruals (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    debit NUMERIC(16, 2) NOT NULL,
    rate NUMERIC(8, 6) NOT NULL,
    days INTEGER NOT NULL,
    amount NUMERIC(16, 8) NOT NULL,
    posted_by VARCHAR(64) REFERENCES sim_activities(id),
    PRIMARY KEY (account_id, "date")
);

-- Hard-to-borrow fees charged at each end of day, once per account, day and symbol
CREATE TABLE IF NOT EXISTS sim_borrow_fees (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    qty NUMERIC(18, 9) NOT NULL,
    price NUMERIC(18, 6) NOT NULL,
    rate NUMERIC(8, 6) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL,
    activity_id VARCHAR(64) REFERENCES sim_activities(id),
    PRIMARY KEY (account_id, "date", symbol)
);

-- Locates for hard-to-borrow short sales (Alpaca's /v1/locates): round lots, single use (used_qty), a non-refundable fee
CREATE TABLE IF NOT EXISTS sim_locates (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    symbol VARCHAR(32) NOT NULL,
    requested_qty INTEGER NOT NULL,
    located_qty INTEGER,
    located_price NUMERIC(12, 4),
    total_fee NUMERIC(14, 2),
    limit_price NUMERIC(12, 4),
    all_or_none BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(10) NOT NULL CHECK (status IN ('active', 'expired', 'rejected')),
    rejection_reason VARCHAR(64),
    used_qty NUMERIC(18, 9) NOT NULL DEFAULT 0,
    fee_activity_id VARCHAR(64) REFERENCES sim_activities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sim_locates_account_idx ON sim_locates (account_id, symbol, created_at);

ALTER TABLE sim_daily_balances ADD COLUMN IF NOT EXISTS initial_margin NUMERIC(16, 2);
ALTER TABLE sim_daily_balances ADD COLUMN IF NOT EXISTS buying_power NUMERIC(16, 2);
ALTER TABLE sim_daily_balances ADD COLUMN IF NOT EXISTS regt_buying_power NUMERIC(16, 2);

COMMIT;
