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
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPLIT', 'DIVIDEND', 'STOCK_DIVIDEND', 'CASH_MERGER', 'STOCK_MERGER', 'MIXED_MERGER', 'SPINOFF', 'NAME_CHANGE', 'WORTHLESS')),
    -- The effective date (the ex-date of splits, dividends and spinoffs)
    ex_date DATE NOT NULL,
    payment_date DATE,
    -- New shares per old share (splits, stock dividends as 1 + the rate, stock mergers, spinoffs) and cash per share (dividends,
    -- cash and mixed mergers)
    factor NUMERIC(18, 8),
    amount NUMERIC(18, 6),
    -- The symbol it leads to: the acquirer, the spun-off company or the new symbol
    new_ticker VARCHAR(32),
    -- alphavantage (splits and dividends) or alpaca (the rest)
    source VARCHAR(16) NOT NULL DEFAULT 'alphavantage',
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

-- Orders in Alpaca's shape, matched by the simulator (lib/server/broker/sim/orders.ts). Open orders are new, accepted (outside their
-- session), partially_filled or held (a bracket or OTO leg waiting for its entry).
CREATE TABLE sim_orders (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    client_order_id VARCHAR(128) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop')),
    time_in_force VARCHAR(4) NOT NULL CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
    order_class VARCHAR(8) NOT NULL DEFAULT 'simple' CHECK (order_class IN ('simple', 'bracket', 'oco', 'oto')),
    position_intent VARCHAR(16),
    qty NUMERIC(18, 9),
    notional NUMERIC(14, 2),
    limit_price NUMERIC(18, 6),
    stop_price NUMERIC(18, 6),
    trail_price NUMERIC(18, 6),
    trail_percent NUMERIC(8, 4),
    hwm NUMERIC(18, 6),
    extended_hours BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL,
    filled_qty NUMERIC(18, 9) NOT NULL DEFAULT 0,
    -- What the fills so far paid or received, for the average price and a notional order's remainder
    filled_notional NUMERIC(14, 2) NOT NULL DEFAULT 0,
    filled_avg_price NUMERIC(18, 6),
    -- Bracket, OCO and OTO orders: the legs' parent, the group they share and each one's role
    parent_id UUID REFERENCES sim_orders(id),
    group_id UUID,
    group_role VARCHAR(12) CHECK (group_role IN ('entry', 'take_profit', 'stop_loss')),
    replaces UUID REFERENCES sim_orders(id),
    replaced_by UUID REFERENCES sim_orders(id),
    stop_triggered_at TIMESTAMPTZ,
    -- When it stops working unless filled (the session close for a day order, 90 days for GTC)
    expires_at TIMESTAMPTZ NOT NULL,
    -- Why it was rejected, cancelled or expired
    reason VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    filled_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    replaced_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    -- Placed by the simulator to meet a margin call (its fills are marked LIQUIDATION)
    liquidation BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (account_id, client_order_id)
);

CREATE INDEX sim_orders_account_idx ON sim_orders (account_id, created_at);
CREATE INDEX sim_orders_open_idx ON sim_orders (status) WHERE status IN ('new', 'accepted', 'partially_filled', 'held', 'pending_new');
CREATE INDEX sim_orders_group_idx ON sim_orders (group_id) WHERE group_id IS NOT NULL;

-- The account ledger's activities: FILL trade fills, CSD cash deposits, CSW cash withdrawals, FEE fees, DIV dividends and SPLIT
-- splits, each with a signed net_amount. id is Alpaca's activity id format ("YYYYMMDDHHMMSSmmm::uuid").
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
    per_share_amount NUMERIC(18, 6),
    -- A FILL's fields (Alpaca's TradeActivity), the P&L it realized against the lots it closed, its settlement date (T+1), the quote it
    -- filled against, the order it filled (order_id), and for fills from before Phase 4 the app's mock order (legacy_order_id)
    side VARCHAR(4) CHECK (side IN ('buy', 'sell')),
    price NUMERIC(18, 6),
    leaves_qty NUMERIC(18, 9),
    cum_qty NUMERIC(18, 9),
    realized_pl NUMERIC(14, 2),
    settle_date DATE,
    reason VARCHAR(32),
    quote_time TIMESTAMPTZ,
    fill_policy VARCHAR(16),
    legacy_order_id INTEGER REFERENCES orders(id),
    order_id UUID REFERENCES sim_orders(id)
);
CREATE INDEX sim_activities_account_idx ON sim_activities (account_id, created_at);

CREATE INDEX sim_activities_type_idx ON sim_activities (account_id, activity_type, symbol, created_at);
CREATE INDEX sim_activities_order_idx ON sim_activities (order_id) WHERE order_id IS NOT NULL;

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
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPLIT', 'DIVIDEND', 'STOCK_DIVIDEND', 'CASH_MERGER', 'STOCK_MERGER', 'MIXED_MERGER', 'SPINOFF', 'NAME_CHANGE', 'WORTHLESS')),
    ex_date DATE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, symbol, "type", ex_date)
);

-- Corporate actions whose effect on open orders (cancelled, or adjusted by a replacement) has been applied, once each
CREATE TABLE sim_corporate_action_orders (
    ticker VARCHAR(255) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    ex_date DATE NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, "type", ex_date)
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
    initial_margin NUMERIC(16, 2),
    buying_power NUMERIC(16, 2),
    regt_buying_power NUMERIC(16, 2),
    PRIMARY KEY (account_id, "date")
);

-- A call for an end-of-day deficiency: issued the next morning, due by due_at, then met (the deficiency is gone or deposits covered
-- it) or liquidated
CREATE TABLE sim_margin_calls (
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
CREATE INDEX sim_margin_calls_account_idx ON sim_margin_calls (account_id, status);

-- Margin interest accrued at each end of day on the settlement-date debit balance, posted at month end as an INT activity
CREATE TABLE sim_interest_accruals (
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
CREATE TABLE sim_borrow_fees (
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
CREATE TABLE sim_locates (
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
CREATE INDEX sim_locates_account_idx ON sim_locates (account_id, symbol, created_at);

-- The simulator's account documents (Alpaca's AccountDocument), each kept with the data it shows; preliminary ones are regenerated
CREATE TABLE sim_documents (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "type" VARCHAR(32) NOT NULL CHECK ("type" IN ('account_application', 'account_statement', 'tax_statement', 'trade_confirmation', 'trade_confirmation_json')),
    sub_type VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    "date" DATE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    preliminary BOOLEAN NOT NULL DEFAULT false,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, "type", period_start, period_end, preliminary)
);
CREATE INDEX sim_documents_account_idx ON sim_documents (account_id, "date");
