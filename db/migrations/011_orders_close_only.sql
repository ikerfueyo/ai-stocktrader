-- Closing orders queued from the Portfolio page (close: true): when one fills, it's capped at the position then open and rejected
-- if there's none, so it can't flip a long into a short or the reverse
ALTER TABLE orders ADD COLUMN close_only BOOLEAN NOT NULL DEFAULT false;
