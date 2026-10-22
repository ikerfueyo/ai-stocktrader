-- Tickers a user watches without owning them
CREATE TABLE watchlist (
    user_id VARCHAR(255) NOT NULL,
    ticker VARCHAR(255) NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, ticker)
);
