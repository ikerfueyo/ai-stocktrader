-- What the app keeps of a broker it reads only through the Broker interface (BROKER=alpaca, or BROKER_LEDGER=broker):
--   order_reasons: why an order ended, from its trade event (Alpaca sends the reason only there, not on the order);
--   broker_activities: a copy of each account's activities (fills and cash activities), so a page load reads only what's new instead
--     of the whole history (lib/server/activityStore.ts); broker_activity_sync: when each account's copy was last read in full.
BEGIN;

CREATE TABLE order_reasons (
    order_id UUID PRIMARY KEY,
    account_id UUID NOT NULL,
    event VARCHAR(32) NOT NULL,
    reason TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE broker_activities (
    account_id UUID NOT NULL,
    -- Alpaca's activity ID, which sorts by time (yyyymmddhhmmssmmm::uuid)
    id VARCHAR(64) NOT NULL,
    activity_type VARCHAR(16) NOT NULL,
    -- The Eastern day it's dated, for the trailing window re-read on every sync
    day DATE NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (account_id, id)
);

CREATE TABLE broker_activity_sync (
    account_id UUID PRIMARY KEY,
    full_sync_at TIMESTAMPTZ NOT NULL
);

COMMIT;
