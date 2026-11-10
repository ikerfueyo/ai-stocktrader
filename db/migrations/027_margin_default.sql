-- An account no longer starts with its own max_margin_multiplier: as on Alpaca, an unset one follows the broker's limit
-- (SIM_MAX_MARGIN_MULTIPLIER, default 4) once the account has the margin agreement. Cash accounts had a stored "1", which had no
-- effect without the agreement but would keep them at 1x after the upgrade to margin, so it's removed. IRAs keep theirs (1x, no
-- margin), and margin accounts keep whatever they have, since a default "2" can't be told apart from one the user chose.
BEGIN;

UPDATE sim_accounts
SET configurations = configurations - 'max_margin_multiplier', updated_at = now()
WHERE account_type <> 'ira'
  AND configurations ? 'max_margin_multiplier'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(agreements) AS a WHERE a->>'agreement' = 'margin_agreement');

COMMIT;
