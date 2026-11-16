-- Indexes for reading orders: an order's legs (parent_id, looked up for every listed entry and on each fill), and an account's orders
-- newest first by submitted_at, as listOrders sorts them (the account index is on created_at).
BEGIN;

CREATE INDEX IF NOT EXISTS sim_orders_parent_idx ON sim_orders (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sim_orders_submitted_idx ON sim_orders (account_id, submitted_at);

COMMIT;
