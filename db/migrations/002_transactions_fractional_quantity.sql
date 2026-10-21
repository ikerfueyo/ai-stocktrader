-- Allow fractional shares, to 6 decimal places.
-- Existing whole-share rows convert without loss.
ALTER TABLE transactions
    ALTER COLUMN quantity TYPE NUMERIC(18, 6);
