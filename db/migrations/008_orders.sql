-- Orders that don't fill right away: limit, stop and stop-limit orders, and market orders placed while the market is closed
-- (queued for the open). A market order for a dollar amount has amount instead of quantity. DAY orders expire at expires_at (the
-- close of the session they were placed for); GTC orders don't expire. Each fill is a transactions row with order_id set.
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
    CHECK ((quantity IS NULL) <> (amount IS NULL))
);
CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at);

ALTER TABLE transactions ADD COLUMN order_id INTEGER REFERENCES orders(id);
