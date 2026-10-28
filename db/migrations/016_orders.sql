-- Phase 4: the simulator's order engine. Orders in Alpaca's shape (sim_orders), matched by the simulator; fills link to their order.
-- The app's mock orders table is no longer read or written; it's kept until someone decides to drop it.
BEGIN;

CREATE TABLE IF NOT EXISTS sim_orders (
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
    UNIQUE (account_id, client_order_id)
);

CREATE INDEX IF NOT EXISTS sim_orders_account_idx ON sim_orders (account_id, created_at);
CREATE INDEX IF NOT EXISTS sim_orders_open_idx ON sim_orders (status) WHERE status IN ('new', 'accepted', 'partially_filled', 'held', 'pending_new');
CREATE INDEX IF NOT EXISTS sim_orders_group_idx ON sim_orders (group_id) WHERE group_id IS NOT NULL;

ALTER TABLE sim_activities ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES sim_orders(id);
CREATE INDEX IF NOT EXISTS sim_activities_order_idx ON sim_activities (order_id) WHERE order_id IS NOT NULL;

COMMIT;
