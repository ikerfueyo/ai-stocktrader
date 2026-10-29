-- Spinoffs and mixed mergers allocate basis by market value. They're applied at the effective date's open, at the quotes then (often
-- without the new company's price, and with the source's price still including it), and trued up with that day's closes once the
-- session is over (trueUpBasisAllocations in lib/server/broker/sim/positions.ts)
BEGIN;

CREATE TABLE IF NOT EXISTS sim_basis_allocations (
    account_id UUID NOT NULL REFERENCES sim_accounts(id),
    symbol VARCHAR(32) NOT NULL,
    "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('SPINOFF', 'MIXED_MERGER')),
    ex_date DATE NOT NULL,
    new_symbol VARCHAR(32) NOT NULL,
    side VARCHAR(5) NOT NULL CHECK (side IN ('long', 'short')),
    factor NUMERIC(18, 9) NOT NULL,
    cash NUMERIC(18, 6),
    -- The share of the basis moved to the new shares when applied (null: no prices, so none for a spinoff, the cash first for a merger)
    share NUMERIC(12, 10),
    -- The mixed merger's cash activity, whose closings are at the cash basis
    cash_fill_id VARCHAR(64) REFERENCES sim_activities(id),
    -- Each source lot's basis before the action, its price after, and a spinoff's new lot or a merger's cash basis (AllocatedLot)
    lots JSONB NOT NULL,
    -- The last lot closing before the action's own: the closings of its lots after this are the ones the allocation priced
    closings_after INTEGER NOT NULL DEFAULT 0,
    -- pending until the closes are known; final once trued up; fallback when they never came (the allocation applied stands)
    status VARCHAR(8) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'final', 'fallback')),
    attempts INTEGER NOT NULL DEFAULT 0,
    final_share NUMERIC(12, 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, symbol, "type", ex_date)
);
CREATE INDEX IF NOT EXISTS sim_basis_allocations_pending_idx ON sim_basis_allocations (ex_date) WHERE status = 'pending';

COMMIT;
