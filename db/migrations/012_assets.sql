-- The tradable universe, shared by all users: U.S. common stocks (no ETFs, funds or OTC listings), synced 3 times a day
-- (lib/server/assets.ts) from Alpha Vantage's LISTING_STATUS (which tells stocks from ETFs) and, when Alpaca keys are set, Alpaca's
-- asset list with its trading flags. The flags are NULL without Alpaca. attributes are Alpaca's (fractional_eh_enabled,
-- has_options, ...). Margin requirements are percentages, as Alpaca gives them.
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
