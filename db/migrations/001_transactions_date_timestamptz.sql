-- Store the full trade time instead of just the day.
-- Existing rows only have a day, so they become midnight in the database server's time zone.
ALTER TABLE transactions
    ALTER COLUMN "date" TYPE TIMESTAMPTZ USING "date"::timestamptz;
