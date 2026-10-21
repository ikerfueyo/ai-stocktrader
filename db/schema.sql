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

-- The cash ledger: deposits and withdrawals, and dividends paid on longs (DIVIDEND_IN) or charged to shorts (DIVIDEND_OUT).
-- Amounts are positive; the type gives the direction.
CREATE TABLE cash_activity (
    id SERIAL PRIMARY KEY,
    -- The Clerk user ID of the account the entry belongs to
    user_id VARCHAR(255) NOT NULL,
    "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "type" VARCHAR(255) NOT NULL CHECK ("type" IN ('DEPOSIT', 'WITHDRAW', 'DIVIDEND_IN', 'DIVIDEND_OUT')),
    -- A display label: the payment method for transfers, or a description of the dividend
    method VARCHAR(255) NOT NULL,
    amount DECIMAL(14, 2) NOT NULL CHECK (amount > 0),
    -- For dividends: the ticker and its ex-dividend date
    ticker VARCHAR(255),
    reference DATE
);

-- Splits and dividends per ticker, shared by all users. ex_date is a split's effective date; factor is new shares per old share
-- (below 1 for a reverse split); amount is a dividend's cash per share.
CREATE TABLE corporate_actions (
    ticker VARCHAR(255) NOT NULL,
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPLIT', 'DIVIDEND')),
    ex_date DATE NOT NULL,
    payment_date DATE,
    factor NUMERIC(18, 8),
    amount NUMERIC(18, 6),
    PRIMARY KEY (ticker, "type", ex_date)
);

-- When each ticker's corporate actions were last fetched
CREATE TABLE corporate_actions_checked (
    ticker VARCHAR(255) PRIMARY KEY,
    checked_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX transactions_user_date_idx ON transactions (user_id, "date", id);
CREATE INDEX cash_activity_user_date_idx ON cash_activity (user_id, "date", id);
-- A dividend is posted at most once per position
CREATE UNIQUE INDEX cash_activity_dividend_idx ON cash_activity (user_id, ticker, reference) WHERE "type" IN ('DIVIDEND_IN', 'DIVIDEND_OUT');
