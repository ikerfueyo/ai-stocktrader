import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeTechnicals, rsi } from "./technicals";

// Closes by date for consecutive days, oldest first
const series = (closes: number[]) => Object.fromEntries(closes.map((close, i) => [new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), close]));

describe("Technicals", () => {
    test("returns over 5, 21 and 63 sessions", () => {
        const closes = Array.from({ length: 64 }, (_, i) => 100 + i);
        const technicals = computeTechnicals(series(closes))!;
        assert.equal(technicals.price, 163);
        assert.ok(Math.abs(technicals.return5d! - (163 / 158 - 1)) < 1e-12);
        assert.ok(Math.abs(technicals.return1m! - (163 / 142 - 1)) < 1e-12);
        assert.ok(Math.abs(technicals.return3m! - (163 / 100 - 1)) < 1e-12);
    });

    test("distance from moving averages, null without enough history", () => {
        const flat = computeTechnicals(series(Array(60).fill(50)))!;
        assert.equal(flat.vsSma50, 0);
        assert.equal(flat.vsSma200, null);
        assert.equal(flat.return3m, null);
    });

    test("RSI is 100 after only gains, 0 after only losses, and in between when mixed", () => {
        assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 10 + i)), 100);
        assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 30 - i)), 0);
        const mixed = rsi(Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1) * (i % 5)))!;
        assert.ok(mixed > 0 && mixed < 100, `rsi ${mixed}`);
        assert.equal(rsi([1, 2, 3]), null);
    });

    test("no closes, no figures", () => {
        assert.equal(computeTechnicals({}), null);
    });
});
