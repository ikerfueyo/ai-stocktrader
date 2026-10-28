-- Phase 10: IRAs (traditional and Roth). An IRA is a sim account with account_type ira and account_sub_type traditional or roth, its
-- beneficiaries (Alpaca's Beneficiary objects, tax IDs masked), and its own broker_accounts row (kind traditional_ira or roth_ira).
-- Transfers carry Alpaca's ira object: a contribution's tax year, a distribution's reason and its federal and state withholding. The
-- app records the IRA disclosure statement it delivered. Tax statements are told apart by sub-type (the consolidated 1099, 1099-R,
-- 5498), so one year can have several.
BEGIN;

ALTER TABLE sim_accounts ADD COLUMN IF NOT EXISTS beneficiaries JSONB;
ALTER TABLE sim_transfers ADD COLUMN IF NOT EXISTS ira JSONB;

ALTER TABLE account_attestations DROP CONSTRAINT IF EXISTS account_attestations_kind_check;
ALTER TABLE account_attestations ADD CONSTRAINT account_attestations_kind_check CHECK (kind IN ('w9', 'form_crs', 'privacy_notice', 'ira_disclosure'));

UPDATE sim_documents SET sub_type = '' WHERE sub_type IS NULL;
ALTER TABLE sim_documents ALTER COLUMN sub_type SET DEFAULT '';
ALTER TABLE sim_documents ALTER COLUMN sub_type SET NOT NULL;
ALTER TABLE sim_documents DROP CONSTRAINT IF EXISTS sim_documents_account_id_type_period_start_period_end_preli_key;
ALTER TABLE sim_documents ADD CONSTRAINT sim_documents_unique_period UNIQUE (account_id, "type", sub_type, period_start, period_end, preliminary);

COMMIT;
