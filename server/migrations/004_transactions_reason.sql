-- Why a trade was made: NULL for the user's own trades, 'LIQUIDATION' for automatic collateral buy-ins.
ALTER TABLE transactions
    ADD COLUMN reason VARCHAR(255);
