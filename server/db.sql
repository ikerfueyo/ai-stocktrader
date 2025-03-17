CREATE DATABASE ai_stocktrader;

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    "date" DATE,
    "type" VARCHAR(255),
    ticker VARCHAR(255),
    price DECIMAL(10, 2),
    quantity INT,
    total DECIMAL(10, 2)
);

