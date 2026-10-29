-- FINRA Rule 4210(d)(2) intraday margin (replacing the pattern day trader rule from June 4, 2026): the margin level after each
-- transaction that lowered it below zero, and each day's intraday margin deficit with its 5th-business-day restriction and
-- 15th-business-day expiry
BEGIN;

-- FINRA Rule 4210(d)(2) intraday margin (lib/server/broker/sim/intradayMargin.ts): the margin level (equity less the maintenance
-- requirement) right after each transaction that lowered it below zero, on margin accounts
CREATE TABLE IF NOT EXISTS sim_intraday_levels (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    at TIMESTAMPTZ NOT NULL,
    before_level NUMERIC(16, 2) NOT NULL,
    level NUMERIC(16, 2) NOT NULL,
    symbol VARCHAR(32)
);
CREATE INDEX IF NOT EXISTS sim_intraday_levels_account_idx ON sim_intraday_levels (account_id, "date");

-- Each day's intraday margin deficit, found at its end of day: satisfied (met_at) by net deposits or an increase in the level from
-- start_level (that day's closing level), outstanding until expire_on's close (status expired); missed when still unmet at
-- restrict_on's close, and restricted_until, with a practice of missing them, the last day new shorts and debit are refused
CREATE TABLE IF NOT EXISTS sim_intraday_deficits (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "date" DATE NOT NULL,
    amount NUMERIC(16, 2) NOT NULL,
    equity NUMERIC(16, 2) NOT NULL,
    start_level NUMERIC(16, 2) NOT NULL,
    de_minimis BOOLEAN NOT NULL,
    restrict_on DATE NOT NULL,
    expire_on DATE NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'expired')),
    met_at TIMESTAMPTZ,
    missed BOOLEAN NOT NULL DEFAULT false,
    restricted_until DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, "date")
);

COMMIT;
