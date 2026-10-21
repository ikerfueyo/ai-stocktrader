-- cash_transfers becomes the account's cash ledger: deposits and withdrawals, plus dividends paid on longs (DIVIDEND_IN) and charged
-- to shorts (DIVIDEND_OUT), with the ticker and ex-dividend date they're for. Amounts stay positive; the type gives the direction.
ALTER TABLE cash_transfers RENAME TO cash_activity;
ALTER SEQUENCE cash_transfers_id_seq RENAME TO cash_activity_id_seq;
ALTER INDEX cash_transfers_pkey RENAME TO cash_activity_pkey;
ALTER INDEX cash_transfers_user_date_idx RENAME TO cash_activity_user_date_idx;
ALTER TABLE cash_activity DROP CONSTRAINT cash_transfers_type_check;
ALTER TABLE cash_activity RENAME CONSTRAINT cash_transfers_amount_check TO cash_activity_amount_check;
ALTER TABLE cash_activity ADD CONSTRAINT cash_activity_type_check CHECK ("type" IN ('DEPOSIT', 'WITHDRAW', 'DIVIDEND_IN', 'DIVIDEND_OUT'));
ALTER TABLE cash_activity ALTER COLUMN amount TYPE DECIMAL(14, 2);
ALTER TABLE cash_activity ADD COLUMN ticker VARCHAR(255);
ALTER TABLE cash_activity ADD COLUMN reference DATE;
-- A dividend is posted at most once per position
CREATE UNIQUE INDEX cash_activity_dividend_idx ON cash_activity (user_id, ticker, reference) WHERE "type" IN ('DIVIDEND_IN', 'DIVIDEND_OUT');

-- Splits and dividends per ticker, shared by all users, from Alpha Vantage's SPLITS and DIVIDENDS. ex_date is a split's effective
-- date; factor is new shares per old share (below 1 for a reverse split); amount is a dividend's cash per share.
CREATE TABLE corporate_actions (
    ticker VARCHAR(255) NOT NULL,
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPLIT', 'DIVIDEND')),
    ex_date DATE NOT NULL,
    payment_date DATE,
    factor NUMERIC(18, 8),
    amount NUMERIC(18, 6),
    PRIMARY KEY (ticker, "type", ex_date)
);

-- When each ticker's corporate actions were last fetched
CREATE TABLE corporate_actions_checked (
    ticker VARCHAR(255) PRIMARY KEY,
    checked_at TIMESTAMPTZ NOT NULL
);
