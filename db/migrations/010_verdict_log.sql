-- Each fresh ticker analysis's verdict, shared by all users, to measure how verdicts turn out (GET /api/analysis/track-record).
-- price and price_date are the newest daily close the analysis saw (NULL without one); prompt_version is PROMPT_VERSION in
-- lib/server/analysis.ts, bumped when the prompts or inputs change.
CREATE TABLE verdict_log (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(255) NOT NULL,
    verdict VARCHAR(4) NOT NULL CHECK (verdict IN ('BUY', 'HOLD', 'SELL')),
    price NUMERIC(18, 6),
    price_date DATE,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    model VARCHAR(255) NOT NULL,
    prompt_version INTEGER NOT NULL
);

CREATE INDEX verdict_log_version_ticker_date_idx ON verdict_log (prompt_version, ticker, price_date, generated_at);
