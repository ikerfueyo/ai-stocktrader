import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { adjustForSplits, computeTechnicals, rsi } from "./technicals";

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

    test("returns less the benchmark's between the same dates", () => {
        const stock = series(Array.from({ length: 64 }, (_, i) => 100 + i));
        const benchmark = series(Array.from({ length: 64 }, (_, i) => 200 + i));
        const technicals = computeTechnicals(stock, benchmark)!;
        assert.ok(Math.abs(technicals.vsBenchmark1m! - ((163 / 142 - 1) - (263 / 242 - 1))) < 1e-12);
        assert.ok(Math.abs(technicals.vsBenchmark3m! - ((163 / 100 - 1) - (263 / 200 - 1))) < 1e-12);
        assert.equal(computeTechnicals(stock)!.vsBenchmark1m, null);
    });

    test("a benchmark a session behind uses its newest close on or before each date", () => {
        const stock = series(Array.from({ length: 30 }, (_, i) => 100 + i));
        const behind = series(Array.from({ length: 29 }, () => 50));
        const technicals = computeTechnicals(stock, behind)!;
        assert.ok(Math.abs(technicals.vsBenchmark1m! - (129 / 108 - 1)) < 1e-12);
        assert.equal(technicals.vsBenchmark3m, null);
    });

    test("no closes, no figures", () => {
        assert.equal(computeTechnicals({}), null);
    });
});

describe("Split adjustment", () => {
    test("closes before a split are divided by its factor, so a 2:1 split isn't a 50% fall", () => {
        // 64 sessions flat at $100 that split 2:1 on the last one, where the price is $50
        const raw = series([...Array(63).fill(100), 50]);
        const dates = Object.keys(raw).sort();
        const adjusted = adjustForSplits(raw, [{ exDate: dates[63], factor: 2 }]);
        assert.equal(adjusted[dates[0]], 50);
        assert.equal(adjusted[dates[63]], 50);
        const technicals = computeTechnicals(adjusted)!;
        assert.equal(technicals.return5d, 0);
        assert.equal(technicals.return3m, 0);
        assert.equal(technicals.rsi14, 50);
        assert.equal(computeTechnicals(raw)!.return5d, -0.5);
    });

    test("a split after the newest close is ignored", () => {
        const raw = series([100, 100]);
        assert.deepEqual(adjustForSplits(raw, [{ exDate: "2027-01-01", factor: 2 }]), raw);
    });
});
