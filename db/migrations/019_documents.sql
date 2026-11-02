-- Phase 7: the simulator's account documents (Alpaca's AccountDocument: trade confirmations and their JSON, monthly statements, the
-- account application and the consolidated 1099), each kept with the data it shows; preliminary ones (development) are regenerated
BEGIN;

CREATE TABLE IF NOT EXISTS sim_documents (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    "type" VARCHAR(32) NOT NULL CHECK ("type" IN ('account_application', 'account_statement', 'tax_statement', 'trade_confirmation', 'trade_confirmation_json')),
    sub_type VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    "date" DATE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    preliminary BOOLEAN NOT NULL DEFAULT false,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, "type", period_start, period_end, preliminary)
);
CREATE INDEX IF NOT EXISTS sim_documents_account_idx ON sim_documents (account_id, "date");

COMMIT;
