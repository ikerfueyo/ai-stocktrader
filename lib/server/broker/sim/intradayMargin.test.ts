import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeMargin, type MarginPosition } from "./margin";
import {
    businessDaysAfter, dayDeficit, deficitDeadlines, deficitSatisfied, deMinimisThreshold, intradayMarginLevel, isDeMinimis, isPractice, reducesMarginLevel,
    restrictionActive, restrictionEnd
} from "./intradayMargin";

const position = (symbol: string, qty: number, price: number): MarginPosition => ({ symbol, qty, price, asset: { marginable: true, marginRequirementLong: null, marginRequirementShort: null } });

describe("Intraday margin level", () => {
    test("equity less the maintenance requirement, negative below it", () => {
        // $10,000 of equity at 4x holds $40,000 of stock, whose 30% maintenance is $12,000: $2,000 below it
        const state = computeMargin({ cash: -30000, positions: [position("AAA", 400, 100)], maxMultiplier: 4, session: "regular" });
        assert.equal(state.equity, 10000);
        assert.equal(intradayMarginLevel(state), -2000);
        assert.equal(intradayMarginLevel(computeMargin({ cash: 10000, positions: [], maxMultiplier: 4, session: "regular" })), 10000);
    });

    test("a transaction reduces it when the level falls by a cent or more", () => {
        assert.equal(reducesMarginLevel(10000, -2000), true);
        assert.equal(reducesMarginLevel(-2000, 8000), false);
        assert.equal(reducesMarginLevel(100, 99.996), false);
    });
});

describe("Intraday margin deficit", () => {
    test("the most negative level after an IML-reducing transaction", () => {
        assert.equal(dayDeficit([]), 0);
        assert.equal(dayDeficit([{ at: "2026-11-02T15:00:00Z", level: 500 }]), 0);
        assert.equal(dayDeficit([{ at: "2026-11-02T15:00:00Z", level: -1200 }, { at: "2026-11-02T16:00:00Z", level: -2000.004 }, { at: "2026-11-02T17:00:00Z", level: -300 }]), 2000);
    });

    test("the day's deposits and withdrawals count as made at its start", () => {
        const levels = [{ at: "2026-11-02T15:00:00Z", level: -2000 }, { at: "2026-11-02T18:00:00Z", level: -1500 }];
        // A $1,000 deposit at 16:00 lowers the first level's deficit to $1,000, not the second's, which came after it
        assert.equal(dayDeficit(levels, [{ at: "2026-11-02T16:00:00Z", amount: 1000 }]), 1500);
        assert.equal(dayDeficit(levels, [{ at: "2026-11-02T19:00:00Z", amount: 2500 }]), 0);
        // A withdrawal later in the day deepens it
        assert.equal(dayDeficit(levels, [{ at: "2026-11-02T19:00:00Z", amount: -100 }]), 2100);
    });

    test("de minimis: the lesser of 5% of equity or $1,000", () => {
        assert.equal(deMinimisThreshold(10000), 500);
        assert.equal(deMinimisThreshold(50000), 1000);
        assert.equal(deMinimisThreshold(-100), 0);
        assert.equal(isDeMinimis(500, 10000), true);
        assert.equal(isDeMinimis(500.01, 10000), false);
        assert.equal(isDeMinimis(1000, 80000), true);
        assert.equal(isDeMinimis(1001, 80000), false);
    });

    test("deadlines in business days: the 5th restricts, the 15th ends it, skipping weekends and holidays", () => {
        assert.equal(businessDaysAfter("2026-11-02", 1), "2026-11-03");
        // Thanksgiving (Nov 26) is skipped
        assert.deepEqual(deficitDeadlines("2026-11-20"), { restrictOn: "2026-11-30", expireOn: "2026-12-14" });
        assert.deepEqual(deficitDeadlines("2026-11-02"), { restrictOn: "2026-11-09", expireOn: "2026-11-23" });
    });

    test("satisfied by net deposits, or by the level's increase since the day ended", () => {
        assert.equal(deficitSatisfied({ amount: 2000, deposits: 2000, levelIncrease: 0 }), true);
        assert.equal(deficitSatisfied({ amount: 2000, deposits: 500, levelIncrease: 1999.996 }), true);
        assert.equal(deficitSatisfied({ amount: 2000, deposits: 1500, levelIncrease: -300 }), false);
    });
});

describe("90-day restriction", () => {
    test("a practice: at least the threshold's misses beyond de minimis in 12 months", () => {
        assert.equal(isPractice(1, 2), false);
        assert.equal(isPractice(2, 2), true);
        assert.equal(isPractice(1, 1), true);
        // A threshold below 1 still needs this miss
        assert.equal(isPractice(0, 0), false);
    });

    test("90 calendar days after the 5th business day, unless the deficit is satisfied", () => {
        assert.equal(restrictionEnd("2026-11-09"), "2027-02-07");
        assert.equal(restrictionActive({ restrictedUntil: "2027-02-07", metAt: null }, "2027-02-07"), true);
        assert.equal(restrictionActive({ restrictedUntil: "2027-02-07", metAt: null }, "2027-02-08"), false);
        assert.equal(restrictionActive({ restrictedUntil: "2027-02-07", metAt: "2026-12-01T01:15:00Z" }, "2026-12-02"), false);
        assert.equal(restrictionActive({ restrictedUntil: null, metAt: null }, "2026-12-02"), false);
    });
});
