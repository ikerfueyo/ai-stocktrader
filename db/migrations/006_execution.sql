-- Server-set fills: prices to 6 decimals (sub-dollar stocks), larger totals, and each fill's quote time and which side of the
-- quote it took (ASK/BID quoted, SIM_ASK/SIM_BID simulated spread, LAST). Existing rows keep NULL for the new columns.
ALTER TABLE transactions
    ALTER COLUMN price TYPE NUMERIC(18, 6),
    ALTER COLUMN total TYPE DECIMAL(14, 2),
    ADD COLUMN quote_time TIMESTAMPTZ,
    ADD COLUMN fill_policy VARCHAR(16) CHECK (fill_policy IN ('ASK', 'BID', 'SIM_ASK', 'SIM_BID', 'LAST'));
