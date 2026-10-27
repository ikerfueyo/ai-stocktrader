import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyFill, applySplit, isLongTerm, positionsFromLots, type Lot } from "./ledger";
import { feesFor, roundFeeUp } from "./feeSchedule";

const lot = (id: string, side: "long" | "short", qty: number, price: number, acquiredAt: string): Lot => ({ id, symbol: "AAA", side, qty, price, acquiredAt });

describe("FIFO lots", () => {
    test("a sale closes the oldest lots first and realizes against their prices", () => {
        const lots = [lot("b", "long", 10, 120, "2026-02-01"), lot("a", "long", 10, 100, "2026-01-01")];
        const { lots: after, closings, opened, realized } = applyFill(lots, { side: "sell", qty: 15, price: 130, at: "2026-03-01" }, "new", "AAA");
        assert.deepEqual(closings.map(({ lotId, qty }) => [lotId, qty]), [["a", 10], ["b", 5]]);
        assert.equal(realized, 10 * 30 + 5 * 10);
        assert.equal(opened, null);
        assert.deepEqual(after, [lot("b", "long", 5, 120, "2026-02-01")]);
    });

    test("selling past the position opens a short lot with the rest", () => {
        const { lots: after, opened, realized } = applyFill([lot("a", "long", 10, 100, "2026-01-01")], { side: "sell", qty: 15, price: 90, at: "2026-03-01" }, "new", "AAA");
        assert.equal(realized, -100);
        assert.deepEqual(opened, { id: "new", symbol: "AAA", side: "short", qty: 5, price: 90, acquiredAt: "2026-03-01" });
        assert.deepEqual(after, [opened]);
    });

    test("a buy covers short lots FIFO, gaining when the price fell", () => {
        const lots = [lot("a", "short", 10, 50, "2026-01-01"), lot("b", "short", 10, 40, "2026-01-02")];
        const { closings, realized, lots: after } = applyFill(lots, { side: "buy", qty: 12, price: 45, at: "2026-03-01" }, "new", "AAA");
        assert.deepEqual(closings.map(({ lotId, qty }) => [lotId, qty]), [["a", 10], ["b", 2]]);
        assert.equal(realized, 10 * 5 + 2 * -5);
        assert.equal(after[0].qty, 8);
    });

    test("a buy with nothing short adds a long lot", () => {
        const { lots: after, closings } = applyFill([lot("a", "long", 1, 100, "2026-01-01")], { side: "buy", qty: 0.5, price: 110, at: "2026-03-01" }, "new", "AAA");
        assert.equal(closings.length, 0);
        assert.equal(after.length, 2);
    });

    test("positions average the open lots, so a FIFO sale changes the average", () => {
        const lots = [lot("a", "long", 10, 100, "2026-01-01"), lot("b", "long", 10, 120, "2026-02-01")];
        assert.deepEqual(positionsFromLots(lots), [{ ticker: "AAA", quantity: 20, avgCost: 110 }]);
        const { lots: after } = applyFill(lots, { side: "sell", qty: 10, price: 130, at: "2026-03-01" }, "new", "AAA");
        assert.deepEqual(positionsFromLots(after), [{ ticker: "AAA", quantity: 10, avgCost: 120 }], "the 100 lot was sold first");
        assert.deepEqual(positionsFromLots([lot("s", "short", 4, 50, "2026-01-01")]), [{ ticker: "AAA", quantity: -4, avgCost: 50 }]);
    });

    test("a split multiplies each lot's shares and divides its price, keeping its cost", () => {
        const [split] = applySplit([lot("a", "long", 3, 300, "2026-01-01")], 4);
        assert.equal(split.qty, 12);
        assert.equal(split.price, 75);
        const [reverse] = applySplit([lot("a", "long", 10, 2, "2026-01-01")], 0.1);
        assert.equal(reverse.qty, 1);
        assert.equal(reverse.price * reverse.qty, 20);
    });

    test("a gain is long-term after more than a year", () => {
        assert.equal(isLongTerm("2025-03-01T15:00:00Z", "2026-03-01T15:00:00Z"), false, "exactly a year is short-term");
        assert.equal(isLongTerm("2025-03-01T15:00:00Z", "2026-03-02T15:00:00Z"), true);
    });
});

describe("Regulatory fees", () => {
    test("sales pay the SEC fee and TAF; buys only the CAT fee", () => {
        const sale = feesFor({ side: "sell", qty: 100, price: 50, date: "2026-06-01" });
        assert.deepEqual(sale.map(({ type }) => type), ["REG", "TAF", "CAT"]);
        assert.ok(Math.abs(sale[0].amount - 5000 * 20.60 / 1e6) < 1e-12);
        assert.ok(Math.abs(sale[1].amount - 100 * 0.000195) < 1e-12);
        assert.deepEqual(feesFor({ side: "buy", qty: 100, price: 50, date: "2026-06-01" }).map(({ type }) => type), ["CAT"]);
    });

    test("the dated rates: no SEC fee from October 2025 to April 2026, no TAF in late 2026", () => {
        assert.deepEqual(feesFor({ side: "sell", qty: 100, price: 50, date: "2026-02-01" }).map(({ type }) => type), ["TAF"]);
        assert.deepEqual(feesFor({ side: "sell", qty: 100, price: 50, date: "2026-10-27" }).map(({ type }) => type), ["REG", "CAT"]);
        assert.deepEqual(feesFor({ side: "sell", qty: 100, price: 50, date: "2027-01-04" }).map(({ type }) => type), ["REG", "TAF", "CAT"]);
    });

    test("TAF is capped per trade", () => {
        const taf = feesFor({ side: "sell", qty: 1e6, price: 1, date: "2026-06-01" }).find(({ type }) => type === "TAF")!;
        assert.equal(taf.amount, 9.79);
    });

    test("a day's fees are rounded up to the cent", () => {
        assert.equal(roundFeeUp(0.0001), 0.01);
        assert.equal(roundFeeUp(0.1), 0.1);
        assert.equal(roundFeeUp(0.10000000001), 0.1);
        assert.equal(roundFeeUp(0), 0);
    });
});
