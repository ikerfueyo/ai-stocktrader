CREATE DATABASE ai_stocktrader;

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    -- The Clerk user ID of the account the trade belongs to
    user_id VARCHAR(255) NOT NULL,
    "date" TIMESTAMPTZ,
    "type" VARCHAR(255),
    ticker VARCHAR(255),
    price NUMERIC(18, 6),
    quantity NUMERIC(18, 6),
    total DECIMAL(14, 2),
    -- NULL for the user's own trades, 'LIQUIDATION' for automatic collateral buy-ins
    reason VARCHAR(255),
    -- The quote the trade filled against, and which side: ASK/BID (quoted), SIM_ASK/SIM_BID (simulated spread) or LAST
    quote_time TIMESTAMPTZ,
    fill_policy VARCHAR(16) CHECK (fill_policy IN ('ASK', 'BID', 'SIM_ASK', 'SIM_BID', 'LAST'))
);

CREATE TABLE cash_transfers (
    id SERIAL PRIMARY KEY,
    -- The Clerk user ID of the account the transfer belongs to
    user_id VARCHAR(255) NOT NULL,
    "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "type" VARCHAR(255) NOT NULL CHECK ("type" IN ('DEPOSIT', 'WITHDRAW')),
    method VARCHAR(255) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0)
);

CREATE INDEX transactions_user_date_idx ON transactions (user_id, "date", id);
CREATE INDEX cash_transfers_user_date_idx ON cash_transfers (user_id, "date", id);
