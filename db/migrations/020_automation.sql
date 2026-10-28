-- Phase 8: the app's own automation and notifications, which work on any broker: notifications from broker events and alerts, with
-- preferences per kind; the event stream's checkpoint; recurring investments; dividend reinvestment; price alerts
BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    account_id UUID,
    kind VARCHAR(24) NOT NULL,
    title VARCHAR(300) NOT NULL,
    body VARCHAR(1000) NOT NULL DEFAULT '',
    link VARCHAR(255),
    -- Makes each at most once (the broker event's ID, or what it's about)
    dedupe_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- Per kind: shown in the app, and as a browser notification (both default to in-app only)
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id VARCHAR(255) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    in_app BOOLEAN NOT NULL DEFAULT true,
    browser BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, kind)
);

-- Where each consumer of the broker's event streams left off (the last event's ULID), to resume after a restart
CREATE TABLE IF NOT EXISTS event_checkpoints (
    consumer VARCHAR(64) PRIMARY KEY,
    last_event_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recurring_investments (
    id UUID PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    account_id UUID NOT NULL REFERENCES broker_accounts(account_id),
    symbol VARCHAR(32) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 1),
    frequency VARCHAR(10) NOT NULL CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly')),
    start_date DATE NOT NULL,
    -- The next scheduled date (it runs on that date's trading day)
    next_date DATE NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
    pause_reason VARCHAR(500),
    last_run_date DATE,
    last_order_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_investments_user_idx ON recurring_investments (user_id, created_at);

-- Dividend reinvestment: the account's default (symbol '*') and each position's own choice
CREATE TABLE IF NOT EXISTS drip_settings (
    account_id UUID NOT NULL REFERENCES broker_accounts(account_id),
    symbol VARCHAR(32) NOT NULL DEFAULT '*',
    enabled BOOLEAN NOT NULL,
    PRIMARY KEY (account_id, symbol)
);
-- Each dividend handled once (reinvested, held back while under $1, or skipped), with the order it placed
CREATE TABLE IF NOT EXISTS drip_reinvestments (
    activity_id VARCHAR(64) PRIMARY KEY,
    account_id UUID NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL,
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('ordered', 'held', 'skipped', 'failed')),
    order_id UUID,
    note VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dividends under the $1 minimum, held until they add up to it
CREATE TABLE IF NOT EXISTS drip_pending (
    account_id UUID NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS price_alerts (
    id UUID PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    condition VARCHAR(12) NOT NULL CHECK (condition IN ('above', 'below', 'change_up', 'change_down')),
    threshold NUMERIC(18, 6) NOT NULL CHECK (threshold > 0),
    -- Fire again on the next crossing (or the next day, for a change alert) instead of once
    rearm BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'cancelled')),
    last_price NUMERIC(18, 6),
    triggered_at TIMESTAMPTZ,
    triggered_on DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_alerts_active_idx ON price_alerts (status, symbol);

COMMIT;
