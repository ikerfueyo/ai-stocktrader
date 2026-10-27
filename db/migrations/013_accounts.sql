-- Brokerage accounts (Phase 1 of docs/brokerage-roadmap.md): each user opens an account through onboarding before trading.
--
-- RESETS EVERY ACCOUNT: the mock ledger's trades, orders and cash activity belong to no brokerage account, so they're deleted and
-- every user starts over. Watchlists, the verdict log, corporate actions and the asset universe stay. The ledger tables
-- themselves stay until the simulator's own ledger replaces them (Phase 3).

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

TRUNCATE orders, transactions, cash_activity RESTART IDENTITY;
