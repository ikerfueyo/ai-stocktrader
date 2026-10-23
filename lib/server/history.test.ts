import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cumulativeReturns, equityHistory, rebase } from "./history";
import type { Trade } from "./account";

const at = (date: string) => `${date}T15:00:00Z`;
const trade = (date: string, type: "BUY" | "SELL", ticker: string, price: number, quantity: number): Trade =>
    ({ date: at(date), type, ticker, price, quantity, total: price * quantity });
const dates = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
const closes = { AAA: { "2026-10-12": 100, "2026-10-13": 110, "2026-10-14": 121, "2026-10-15": 121 } };

describe("Equity history", () => {
    test("a buy-and-hold matches the stock's return", () => {
        const history = equityHistory({
            trades: [trade("2026-10-12", "BUY", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }],
            closes, dates
        });
        assert.deepEqual(history.map(({ equity }) => equity), [1000, 1100, 1210, 1210]);
        assert.ok(Math.abs(history[3].twr - 0.21) < 1e-9);
    });

    test("there's no return on a day that starts without positive equity", () => {
        const history = equityHistory({
            trades: [trade("2026-10-12", "BUY", "AAA", 100, 10), trade("2026-10-12", "SELL", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-14"), amount: 5000, external: true }],
            closes, dates
        });
        assert.deepEqual(history.map(({ equity }) => equity), [0, 0, 5000, 5000]);
        assert.deepEqual(history.map(({ defined }) => defined), [false, false, false, true]);
        assert.deepEqual(history.map(({ twr }) => twr), [0, 0, 0, 0]);
    });

    test("a day that ends with negative equity adds nothing", () => {
        const crashing = { AAA: { "2026-10-12": 100, "2026-10-13": 300 } };
        const history = equityHistory({
            trades: [trade("2026-10-12", "SELL", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }],
            closes: crashing, dates: dates.slice(0, 2)
        });
        assert.deepEqual(history.map(({ equity }) => equity), [1000, -1000]);
        assert.deepEqual(history.map(({ defined }) => defined), [false, false]);
        assert.equal(history[1].twr, 0);
    });

    test("a deposit raises equity but not the time-weighted return", () => {
        const history = equityHistory({
            trades: [trade("2026-10-12", "BUY", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }, { date: at("2026-10-14"), amount: 5000, external: true }],
            closes, dates
        });
        assert.equal(history[2].equity, 6210);
        assert.equal(history[2].netDeposits, 6000);
        assert.ok(Math.abs(history[3].twr - 0.21) < 1e-9, `twr ${history[3].twr}`);
    });

    test("a weekend deposit isn't return on the next trading day", () => {
        // Cash only: $100 on Friday, $100 more on Saturday
        const history = equityHistory({
            trades: [],
            cash: [{ date: at("2026-10-16"), amount: 100, external: true }, { date: at("2026-10-17"), amount: 100, external: true }],
            closes: {}, dates: ["2026-10-16", "2026-10-19"]
        });
        assert.deepEqual(history.map(({ equity }) => equity), [100, 200]);
        assert.deepEqual(history.map(({ twr }) => twr), [0, 0]);
    });

    test("a split takes effect on its date, not the day before", () => {
        // 10 shares at $100, split 2:1 on the 14th, when the price halves: worth $1,000 throughout
        const history = equityHistory({
            trades: [trade("2026-10-12", "BUY", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }],
            splits: [{ ticker: "AAA", exDate: "2026-10-14", factor: 2 }],
            closes: { AAA: { "2026-10-12": 100, "2026-10-13": 100, "2026-10-14": 50, "2026-10-15": 50 } },
            dates
        });
        assert.deepEqual(history.map(({ equity }) => equity), [1000, 1000, 1000, 1000]);
        assert.deepEqual(history.map(({ twr }) => twr), [0, 0, 0, 0]);
    });

    test("dividends count as return", () => {
        const history = equityHistory({
            trades: [],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }, { date: at("2026-10-13"), amount: 10, external: false }],
            closes, dates
        });
        assert.ok(Math.abs(history[1].twr - 0.01) < 1e-9);
    });

    test("a short gains as the price falls", () => {
        const falling = { AAA: { "2026-10-12": 100, "2026-10-13": 90 } };
        const history = equityHistory({
            trades: [trade("2026-10-12", "SELL", "AAA", 100, 10)],
            cash: [{ date: at("2026-10-12"), amount: 1000, external: true }],
            closes: falling, dates: dates.slice(0, 2)
        });
        assert.deepEqual(history.map(({ equity }) => equity), [1000, 1100]);
    });
});

describe("Benchmark returns", () => {
    test("cumulative returns from the first price, rebased to a later start", () => {
        const returns = cumulativeReturns({ "2026-10-12": 100, "2026-10-14": 120 }, dates);
        assert.deepEqual(returns, [0, 0, 0.19999999999999996, 0.19999999999999996]);
        const rebased = rebase(returns.slice(2));
        assert.equal(rebased[0], 0);
    });
});
