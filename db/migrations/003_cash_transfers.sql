-- Mock deposits and withdrawals, which together with trades make up the available cash.
-- method is only a display label such as "Visa •••• 4242"; no card or bank details are stored.
CREATE TABLE cash_transfers (
    id SERIAL PRIMARY KEY,
    "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "type" VARCHAR(255) NOT NULL CHECK ("type" IN ('DEPOSIT', 'WITHDRAW')),
    method VARCHAR(255) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0)
);
