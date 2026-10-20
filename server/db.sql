CREATE DATABASE ai_stocktrader;

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    "date" TIMESTAMPTZ,
    "type" VARCHAR(255),
    ticker VARCHAR(255),
    price DECIMAL(10, 2),
    quantity NUMERIC(18, 6),
    total DECIMAL(10, 2)
);

