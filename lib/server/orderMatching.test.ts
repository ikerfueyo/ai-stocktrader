import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrder, reservedForOrders, type OpenOrder } from "./orderMatching";
import { valueAccount } from "./account";

const order = (overrides: Partial<OpenOrder>): OpenOrder => ({
    id: 1, ticker: "AAA", side: "BUY", orderType: "LIMIT", quantity: 10, amount: null,
    limitPrice: null, stopPrice: null, timeInForce: "GTC", expiresAt: null, triggeredAt: null, closeOnly: false,
    ...overrides
});
const quote = (price: number, spread = 0.1) => ({ price, bid: price - spread / 2, ask: price + spread / 2, spread: "quoted" as const });
const now = new Date("2026-10-21T15:00:00Z");
const open = { now, marketOpen: true };

describe("Limit orders", () => {
    test("a buy limit fills at the ask once the ask is at or below the limit", () => {
        const buy = order({ limitPrice: 100 });
        assert.deepEqual(evaluateOrder(buy, quote(100.1), open), { action: "none" });
        assert.deepEqual(evaluateOrder(buy, quote(99.95), open), { action: "fill", price: 100, fillPolicy: "ASK", triggered: false });
        assert.deepEqual(evaluateOrder(buy, quote(90), open), { action: "fill", price: 90.05, fillPolicy: "ASK", triggered: false });
    });

    test("a sell limit fills at the bid once the bid is at or above the limit", () => {
        const sell = order({ side: "SELL", limitPrice: 100 });
        assert.deepEqual(evaluateOrder(sell, quote(100), open), { action: "none" });
        assert.deepEqual(evaluateOrder(sell, quote(101), open), { action: "fill", price: 100.95, fillPolicy: "BID", triggered: false });
    });

    test("nothing fills while the market is closed or without a quote", () => {
        const buy = order({ limitPrice: 100 });
        assert.deepEqual(evaluateOrder(buy, quote(90), { now, marketOpen: false }), { action: "none" });
        assert.deepEqual(evaluateOrder(buy, null, open), { action: "none" });
    });
});

describe("Stop and stop-limit orders", () => {
    test("a sell stop fills like a market order once the price falls to the stop", () => {
        const stop = order({ side: "SELL", orderType: "STOP", stopPrice: 95 });
        assert.deepEqual(evaluateOrder(stop, quote(96), open), { action: "none" });
        assert.deepEqual(evaluateOrder(stop, quote(94), open), { action: "fill", price: 93.95, fillPolicy: "BID", triggered: true });
    });

    test("a buy stop triggers at or above the stop", () => {
        const stop = order({ orderType: "STOP", stopPrice: 110 });
        assert.equal(evaluateOrder(stop, quote(109), open).action, "none");
        assert.equal(evaluateOrder(stop, quote(110), open).action, "fill");
    });

    test("a stop-limit becomes a limit order once triggered, and stays triggered", () => {
        const stopLimit = order({ side: "SELL", orderType: "STOP_LIMIT", stopPrice: 95, limitPrice: 94 });
        assert.deepEqual(evaluateOrder(stopLimit, quote(93), open), { action: "trigger" });
        assert.equal(evaluateOrder(stopLimit, quote(94.5), open).action, "fill", "triggered and marketable at once");
        const triggered = { ...stopLimit, triggeredAt: now };
        assert.deepEqual(evaluateOrder(triggered, quote(93), open), { action: "none" });
        assert.deepEqual(evaluateOrder(triggered, quote(96), open), { action: "fill", price: 95.95, fillPolicy: "BID", triggered: false });
    });
});

describe("Queued market orders and expiry", () => {
    test("a queued market order fills at the first check while the market is open", () => {
        assert.deepEqual(evaluateOrder(order({ orderType: "MARKET" }), quote(50), open), { action: "fill", price: 50.05, fillPolicy: "ASK", triggered: false });
    });

    test("a DAY order expires at its close, even while the market is closed", () => {
        const day = order({ limitPrice: 100, timeInForce: "DAY", expiresAt: new Date("2026-10-21T20:00:00Z") });
        assert.equal(evaluateOrder(day, quote(120), { now: new Date("2026-10-21T19:59:00Z"), marketOpen: true }).action, "none");
        assert.equal(evaluateOrder(day, quote(120), { now: new Date("2026-10-21T20:00:00Z"), marketOpen: false }).action, "expire");
    });
});

describe("Reserved cash", () => {
    const positions = [{ ticker: "AAA", quantity: 10, avgCost: 90 }, { ticker: "BBB", quantity: -5, avgCost: 40 }];

    test("opening orders reserve their cost (buys) or half their value (shorts); reducing orders reserve nothing", () => {
        const orders = [
            order({ ticker: "CCC", limitPrice: 20, quantity: 10 }),                            // buy: $200
            order({ ticker: "DDD", side: "SELL", limitPrice: 30, quantity: 10 }),               // new short: $150
            order({ ticker: "AAA", side: "SELL", limitPrice: 100, quantity: 10 }),              // sells the long: nothing
            order({ ticker: "BBB", orderType: "STOP", stopPrice: 45, quantity: 5 }),            // covers the short: nothing
            order({ ticker: "EEE", orderType: "MARKET", quantity: null, amount: 500 })          // queued $500 buy
        ];
        assert.equal(reservedForOrders(orders, positions, {}), 200 + 150 + 500);
    });

    test("a sale larger than the long (a flip) reserves", () => {
        assert.equal(reservedForOrders([order({ side: "SELL", limitPrice: 100, quantity: 12 })], positions, {}), 600);
    });

    test("a reservation reduces available cash but not equity", () => {
        const without = valueAccount({ positions: [], totalCash: 1000, prices: {} });
        const withReserve = valueAccount({ positions: [], totalCash: 1000, prices: {}, reservedCash: 300 });
        assert.equal(withReserve.availableCash, 700);
        assert.equal(withReserve.equity, without.equity);
        assert.equal(valueAccount({ positions: [], totalCash: 200, prices: {}, reservedCash: 300 }).availableCash, 0);
    });
});
