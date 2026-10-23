CREATE DATABASE ai_stocktrader;

-- Orders that don't fill right away: limit, stop and stop-limit orders, and market orders queued while the market is closed (a
-- dollar-amount market order has amount instead of quantity). DAY orders expire at expires_at; GTC orders don't expire.
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ticker VARCHAR(255) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type VARCHAR(16) NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT')),
    quantity NUMERIC(18, 6) CHECK (quantity > 0),
    amount DECIMAL(14, 2) CHECK (amount > 0),
    limit_price NUMERIC(18, 6) CHECK (limit_price > 0),
    stop_price NUMERIC(18, 6) CHECK (stop_price > 0),
    time_in_force VARCHAR(3) NOT NULL CHECK (time_in_force IN ('DAY', 'GTC')),
    expires_at TIMESTAMPTZ,
    status VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
    -- When a stop or stop-limit order's stop price was reached
    triggered_at TIMESTAMPTZ,
    -- Why an order was rejected, expired or cancelled
    status_reason VARCHAR(500),
    -- A closing order (Portfolio page): capped at the open position when it fills, so it can't flip it
    close_only BOOLEAN NOT NULL DEFAULT false,
    CHECK ((quantity IS NULL) <> (amount IS NULL))
);

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
    fill_policy VARCHAR(16) CHECK (fill_policy IN ('ASK', 'BID', 'SIM_ASK', 'SIM_BID', 'LAST')),
    -- The order this trade filled, for limit, stop and queued orders
    order_id INTEGER REFERENCES orders(id)
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

CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at);
CREATE INDEX transactions_user_date_idx ON transactions (user_id, "date", id);
CREATE INDEX cash_activity_user_date_idx ON cash_activity (user_id, "date", id);
-- A dividend is posted at most once per position
CREATE UNIQUE INDEX cash_activity_dividend_idx ON cash_activity (user_id, ticker, reference) WHERE "type" IN ('DIVIDEND_IN', 'DIVIDEND_OUT');

-- Tickers a user watches without owning them
CREATE TABLE watchlist (
    user_id VARCHAR(255) NOT NULL,
    ticker VARCHAR(255) NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, ticker)
);

-- Each fresh ticker analysis's verdict, shared by all users, to measure how verdicts turn out (GET /api/analysis/track-record).
-- price and price_date are the newest daily close the analysis saw (NULL without one); prompt_version is PROMPT_VERSION in
-- lib/server/analysis.ts, bumped when the prompts or inputs change.
CREATE TABLE verdict_log (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(255) NOT NULL,
    verdict VARCHAR(4) NOT NULL CHECK (verdict IN ('BUY', 'HOLD', 'SELL')),
    price NUMERIC(18, 6),
    price_date DATE,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    model VARCHAR(255) NOT NULL,
    prompt_version INTEGER NOT NULL
);

CREATE INDEX verdict_log_version_ticker_date_idx ON verdict_log (prompt_version, ticker, price_date, generated_at);
