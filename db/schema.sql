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

-- The tradable universe, shared by all users: U.S. common stocks (no ETFs, funds or OTC listings), synced from Alpha Vantage's
-- LISTING_STATUS and Alpaca's asset list (lib/server/assets.ts). The trading flags are NULL without Alpaca keys.
CREATE TABLE assets (
    symbol VARCHAR(32) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    exchange VARCHAR(32) NOT NULL,
    alpaca_id UUID,
    tradable BOOLEAN,
    marginable BOOLEAN,
    shortable BOOLEAN,
    borrow_status VARCHAR(32),
    fractionable BOOLEAN,
    margin_requirement_long NUMERIC(8, 4),
    margin_requirement_short NUMERIC(8, 4),
    attributes TEXT[] NOT NULL DEFAULT '{}',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which brokerage accounts each user has (one individual account for now; IRAs come later). broker is where the account lives:
-- the simulator's sim_accounts, or Alpaca.
CREATE TABLE broker_accounts (
    account_id UUID PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    broker VARCHAR(16) NOT NULL DEFAULT 'sim' CHECK (broker IN ('sim', 'alpaca')),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('individual', 'traditional_ira', 'roth_ira')),
    account_number VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX broker_accounts_user_idx ON broker_accounts (user_id, created_at);

-- What the applicant attested at onboarding, kept by the app rather than the broker: the W-9 certification (details:
-- { backup_withholding }) and the delivery of Form CRS and the privacy notice
CREATE TABLE account_attestations (
    id SERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES broker_accounts(account_id),
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('w9', 'form_crs', 'privacy_notice')),
    details JSONB NOT NULL DEFAULT '{}',
    signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address VARCHAR(64) NOT NULL
);

-- The simulator's accounts (SimBroker), in Alpaca's Account shape. identity's tax_id is stored masked (only its last 4 digits).
-- status_due_at is when the next automatic review step is due (lib/server/broker/sim/kyc.ts). documents holds the metadata of
-- uploaded documents; their content is discarded.
CREATE TABLE sim_accounts (
    id UUID PRIMARY KEY,
    account_number VARCHAR(32) NOT NULL UNIQUE,
    account_type VARCHAR(16) NOT NULL DEFAULT 'trading',
    account_sub_type VARCHAR(16),
    status VARCHAR(32) NOT NULL,
    status_due_at TIMESTAMPTZ,
    contact JSONB NOT NULL,
    identity JSONB NOT NULL,
    disclosures JSONB NOT NULL,
    agreements JSONB NOT NULL,
    trusted_contact JSONB,
    enabled_assets TEXT[] NOT NULL DEFAULT '{us_equity}',
    kyc_results JSONB,
    configurations JSONB NOT NULL,
    options_approved_level INTEGER NOT NULL DEFAULT 0,
    documents JSONB NOT NULL DEFAULT '[]',
    trading_blocked BOOLEAN NOT NULL DEFAULT false,
    transfers_blocked BOOLEAN NOT NULL DEFAULT false,
    account_blocked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
);
CREATE INDEX sim_accounts_review_idx ON sim_accounts (status, status_due_at);

-- Options approval requests (POST /v1/accounts/{id}/options/approval), decided when due_at passes
CREATE TABLE sim_options_approvals (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    requested_level INTEGER NOT NULL CHECK (requested_level BETWEEN 1 AND 3),
    approved_level INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'LOWER_LEVEL_APPROVED', 'REJECTED')),
    due_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The simulator's event streams (Alpaca's SSE streams): one row per event, its ULID id ordered within each account, the payload in
-- the stream's own shape
CREATE TABLE sim_events (
    id CHAR(26) PRIMARY KEY,
    account_id UUID NOT NULL,
    stream VARCHAR(16) NOT NULL CHECK (stream IN ('trades', 'accounts', 'transfers', 'nta')),
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL
);
CREATE INDEX sim_events_account_idx ON sim_events (account_id, id);

-- ACH relationships (bank links): one active (QUEUED or APPROVED) per account. status_due_at is when verification finishes.
CREATE TABLE sim_ach_relationships (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    status VARCHAR(20) NOT NULL CHECK (status IN ('QUEUED', 'APPROVED', 'REJECTED', 'PENDING', 'CANCEL_REQUESTED', 'CANCELED')),
    status_due_at TIMESTAMPTZ,
    reason VARCHAR(255),
    account_owner_name VARCHAR(255) NOT NULL,
    bank_account_type VARCHAR(8) NOT NULL CHECK (bank_account_type IN ('CHECKING', 'SAVINGS')),
    bank_account_number VARCHAR(16) NOT NULL,
    bank_routing_number VARCHAR(9) NOT NULL,
    nickname VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sim_ach_relationships_active_idx ON sim_ach_relationships (account_id) WHERE status IN ('QUEUED', 'APPROVED', 'PENDING');

-- Banks an account can wire money out to (Alpaca's recipient banks)
CREATE TABLE sim_recipient_banks (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    status VARCHAR(20) NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('QUEUED', 'SENT_TO_CLEARING', 'APPROVED', 'REJECTED', 'CANCELED')),
    name VARCHAR(255) NOT NULL,
    bank_code VARCHAR(16) NOT NULL,
    bank_code_type VARCHAR(4) NOT NULL CHECK (bank_code_type IN ('ABA', 'BIC')),
    account_number VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transfers, in Alpaca's lifecycle. sent_at and complete_at are when they go to clearing and complete (lib/server/broker/sim/
-- funding.ts); return_at and return_code are set for a deposit that will come back (a NACHA return).
CREATE TABLE sim_transfers (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "type" VARCHAR(4) NOT NULL CHECK ("type" IN ('ach', 'wire')),
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('INCOMING', 'OUTGOING')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('QUEUED', 'APPROVAL_PENDING', 'PENDING', 'SENT_TO_CLEARING', 'REJECTED', 'CANCELED', 'APPROVED', 'COMPLETE', 'RETURNED')),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    instant_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    fee NUMERIC(14, 2) NOT NULL DEFAULT 0,
    relationship_id UUID REFERENCES sim_ach_relationships(id),
    bank_id UUID REFERENCES sim_recipient_banks(id),
    reason VARCHAR(255),
    sent_at TIMESTAMPTZ NOT NULL,
    complete_at TIMESTAMPTZ NOT NULL,
    return_at TIMESTAMPTZ,
    return_code VARCHAR(4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sim_transfers_account_idx ON sim_transfers (account_id, created_at);
CREATE INDEX sim_transfers_due_idx ON sim_transfers (status, sent_at, complete_at);

-- The account ledger's activities (Alpaca's non-trade activities for now: CSD cash deposits, CSW cash withdrawals, FEE), each with a
-- signed net_amount. Trade fills join it in Phase 3. id is Alpaca's activity id format ("YYYYMMDDHHMMSSmmm::uuid").
CREATE TABLE sim_activities (
    id VARCHAR(64) PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    activity_type VARCHAR(8) NOT NULL,
    activity_sub_type VARCHAR(32),
    "date" DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    net_amount NUMERIC(14, 2) NOT NULL,
    description VARCHAR(255) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'executed',
    transfer_id UUID REFERENCES sim_transfers(id),
    symbol VARCHAR(32),
    qty NUMERIC(18, 9),
    per_share_amount NUMERIC(18, 6)
);
CREATE INDEX sim_activities_account_idx ON sim_activities (account_id, created_at);
