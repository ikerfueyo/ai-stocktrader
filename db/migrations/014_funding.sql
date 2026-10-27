-- Funding (Phase 2 of docs/brokerage-roadmap.md): the simulator's bank links, wire recipients, transfers and the start of its
-- account ledger. Bank account numbers are stored masked (only their last 4 digits).

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

-- Deposits and withdrawals now come from the simulator's ledger; the mock ledger's cash_activity keeps dividends
DELETE FROM cash_activity WHERE "type" IN ('DEPOSIT', 'WITHDRAW');
