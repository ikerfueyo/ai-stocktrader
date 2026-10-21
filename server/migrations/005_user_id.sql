-- Each trade and transfer belongs to a Clerk user (its user ID, such as user_2abc...). Existing rows are assigned to one user,
-- passed as a psql variable. Sign up in the app first and copy your user ID from the Clerk dashboard (Users), then run:
--   psql -U postgres -d ai_stocktrader -v owner=user_... -f server/migrations/005_user_id.sql
\if :{?owner}
\else
    \echo 'Pass the Clerk user ID that owns the existing rows: -v owner=user_...'
    \quit
\endif

BEGIN;

ALTER TABLE transactions ADD COLUMN user_id VARCHAR(255);
ALTER TABLE cash_transfers ADD COLUMN user_id VARCHAR(255);

UPDATE transactions SET user_id = :'owner';
UPDATE cash_transfers SET user_id = :'owner';

ALTER TABLE transactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE cash_transfers ALTER COLUMN user_id SET NOT NULL;

-- Every account query filters by user and sorts by date
CREATE INDEX transactions_user_date_idx ON transactions (user_id, "date", id);
CREATE INDEX cash_transfers_user_date_idx ON cash_transfers (user_id, "date", id);

COMMIT;
