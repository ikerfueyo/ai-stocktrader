import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    borrowFee, buyingPowerCost, computeMargin, deficiencies, effectiveMultiplier, isRoundLot, maintenanceFor, marginInterest, needsImmediateLiquidation,
    planLiquidation, shortingBlocked, type MarginAsset, type MarginPosition
} from "./margin";

const asset = (overrides: Partial<MarginAsset> = {}): MarginAsset => ({ marginable: true, marginRequirementLong: null, marginRequirementShort: null, ...overrides });
const position = (symbol: string, qty: number, price: number, overrides: Partial<MarginAsset> = {}): MarginPosition => ({ symbol, qty, price, asset: asset(overrides) });

describe("Buying power", () => {
    test("1x is cash: below $2,000 of equity, or without the margin agreement", () => {
        assert.equal(computeMargin({ cash: 1500, positions: [], maxMultiplier: 2, session: "regular" }).buyingPower, 1500);
        assert.equal(computeMargin({ cash: 10000, positions: [], maxMultiplier: 1, session: "regular" }).buyingPower, 10000);
        const longs = computeMargin({ cash: 4000, positions: [position("AAA", 10, 100)], maxMultiplier: 1, session: "regular" });
        assert.deepEqual([longs.multiplier, longs.buyingPower, longs.equity], [1, 4000, 5000]);
    });

    test("2x overnight: (equity - initial margin) × 2, as Alpaca's docs give it", () => {
        // $10,000 of cash can hold $20,000 of marginable stock overnight
        const fresh = computeMargin({ cash: 10000, positions: [], maxMultiplier: 2, session: "after-hours" });
        assert.deepEqual([fresh.multiplier, fresh.buyingPower, fresh.regtBuyingPower], [2, 20000, 20000]);
        const full = computeMargin({ cash: -10000, positions: [position("AAA", 200, 100)], maxMultiplier: 2, session: "after-hours" });
        assert.deepEqual([full.equity, full.initialMargin, full.buyingPower, full.debit], [10000, 10000, 0, 10000]);
    });

    test("4x intraday for 4x accounts, back to 2x outside the regular session", () => {
        // $50,000 can hold $200,000 intraday
        assert.equal(computeMargin({ cash: 50000, positions: [], maxMultiplier: 4, session: "regular" }).buyingPower, 200000);
        assert.equal(computeMargin({ cash: 50000, positions: [], maxMultiplier: 4, session: "pre-market" }).buyingPower, 100000);
        assert.equal(effectiveMultiplier(1999, 4, "regular"), 1);
    });

    test("non-marginable stock needs 100% initial margin, so it costs twice the buying power at 2x", () => {
        const held = computeMargin({ cash: 5000, positions: [position("PNY", 1000, 5, { marginable: false })], maxMultiplier: 2, session: "regular" });
        assert.deepEqual([held.initialMargin, held.buyingPower], [5000, 10000]);
        assert.equal(buyingPowerCost(1000, { marginable: false, multiplier: 2 }), 2000);
        assert.equal(buyingPowerCost(1000, { marginable: true, multiplier: 2 }), 1000);
    });

    test("a short's proceeds stay in cash but its Reg T requirement holds back buying power", () => {
        // $10,000 of cash, then $4,000 shorted: cash $14,000, equity unchanged
        const shorted = computeMargin({ cash: 14000, positions: [position("SHT", -40, 100)], maxMultiplier: 2, session: "regular" });
        assert.deepEqual([shorted.equity, shorted.initialMargin, shorted.buyingPower], [10000, 2000, 16000]);
        assert.equal(computeMargin({ cash: 14000, positions: [position("SHT", -40, 100)], maxMultiplier: 1, session: "regular" }).buyingPower, 8000);
    });

    test("open orders hold back buying power", () => {
        assert.equal(computeMargin({ cash: 10000, positions: [], maxMultiplier: 2, session: "regular", reserved: 3000 }).buyingPower, 17000);
    });
});

describe("Maintenance requirements", () => {
    test("longs by price: 100% below $2.50, 50% to $6, 30% above", () => {
        assert.equal(maintenanceFor(position("A", 100, 2)), 200);
        assert.equal(maintenanceFor(position("A", 100, 5)), 250);
        assert.equal(maintenanceFor(position("A", 100, 50)), 1500);
        assert.equal(maintenanceFor(position("A", 100, 50, { marginable: false })), 5000);
    });

    test("shorts: the greater of $2.50 a share or 100% below $5, of $5 a share or 30% from $5", () => {
        assert.equal(maintenanceFor(position("S", -100, 1)), 250);
        assert.equal(maintenanceFor(position("S", -100, 4)), 400);
        assert.equal(maintenanceFor(position("S", -100, 10)), 500);
        assert.equal(maintenanceFor(position("S", -100, 50)), 1500);
    });

    test("an asset's own higher requirement, and a concentrated position at 50%", () => {
        assert.equal(maintenanceFor(position("A", 100, 50, { marginRequirementLong: 40 })), 2000);
        assert.equal(maintenanceFor(position("A", 100, 50, { marginRequirementLong: 25 })), 1500);
        assert.equal(maintenanceFor(position("S", -100, 50, { marginRequirementShort: 100 })), 5000);
        const concentrated = computeMargin({ cash: -150000, positions: [position("BIG", 2000, 150), position("SML", 100, 100)], maxMultiplier: 2, session: "regular" });
        assert.equal(concentrated.concentrated, "BIG");
        assert.equal(concentrated.maintenanceMargin, 0.5 * 300000 + 0.3 * 10000);
        assert.equal(computeMargin({ cash: -50000, positions: [position("BIG", 2000, 150)], maxMultiplier: 2, session: "regular" }).concentrated, null, "a margin balance under $100,000");
    });
});

describe("Margin calls and liquidation", () => {
    test("maintenance from any cause; Reg T only after a day that opened positions", () => {
        // $10,000 borrowed against $16,000 of stock: equity $6,000, maintenance $4,800, Reg T $8,000
        const state = computeMargin({ cash: -10000, positions: [position("AAA", 160, 100)], maxMultiplier: 2, session: "closed" });
        assert.deepEqual(deficiencies(state, { openedToday: false }), { maintenance: 0, regt: 0 });
        assert.deepEqual(deficiencies(state, { openedToday: true }), { maintenance: 0, regt: 2000 });
        const fallen = computeMargin({ cash: -10000, positions: [position("AAA", 160, 75)], maxMultiplier: 2, session: "closed" });
        assert.equal(deficiencies(fallen, { openedToday: false }).maintenance, 1600, "equity $2,000 against $3,600");
    });

    test("immediate liquidation when equity is far below maintenance, or gone", () => {
        const state = { equity: 2000, maintenanceMargin: 3600, longMarketValue: 12000, shortMarketValue: 0 };
        assert.equal(needsImmediateLiquidation(state, 0.75), true);
        assert.equal(needsImmediateLiquidation({ ...state, equity: 3000 }, 0.75), false);
        assert.equal(needsImmediateLiquidation({ ...state, equity: -1 }, 0.1), true);
        assert.equal(needsImmediateLiquidation({ equity: 0, maintenanceMargin: 0, longMarketValue: 0, shortMarketValue: 0 }, 0.75), false);
    });

    test("liquidation closes the riskiest positions first, just enough", () => {
        const positions = [position("SAFE", 100, 100), position("PENNY", 1000, 2), position("SHT", -50, 40)];
        const trades = planLiquidation(positions, 500, { type: "maintenance", equity: 1000 });
        // The penny stock's 100% requirement goes first: $500 × 1.05 of it
        assert.deepEqual(trades, [{ symbol: "PENNY", side: "sell", qty: 263 }]);
        // Then the 30% ones, the larger first
        const some = planLiquidation(positions, 3000, { type: "maintenance", equity: 1000 });
        assert.deepEqual(some, [{ symbol: "PENNY", side: "sell", qty: 1000 }, { symbol: "SAFE", side: "sell", qty: 39 }]);
        const more = planLiquidation(positions, 6000, { type: "maintenance", equity: 1000 });
        assert.deepEqual(more.map(({ symbol, side, qty }) => `${side} ${qty} ${symbol}`), ["sell 1000 PENNY", "sell 100 SAFE", "buy 50 SHT"]);
        assert.equal(planLiquidation(positions, 10, { type: "maintenance", equity: -5 }).length, 3, "equity gone: close everything");
        assert.deepEqual(planLiquidation([position("FRC", 2.5, 100)], 10, { type: "regt", equity: 100 }), [{ symbol: "FRC", side: "sell", qty: 0.21 }]);
    });

    // F at $11.73 (30% maintenance), a $10 put and a $13 call on it, both Nov 20, 2026
    const option = (symbol: string, qty: number, price: number): MarginPosition => ({ symbol, qty, price, asset: null, multiplier: 100, option: true });
    const PUT = "F261120P00010000", CALL = "F261120C00013000";

    test("liquidation buys back short options when that releases the most per dollar", () => {
        // Each short put needs its $1,000 strike and costs $5 to buy back; the shares release 30% of their value
        const positions = [position("F", 100, 11.73), option(PUT, -2, 0.05)];
        assert.deepEqual(planLiquidation(positions, 500, { type: "maintenance", equity: 1000 }), [{ symbol: PUT, side: "buy", qty: 1 }], "one contract covers $525");
        assert.deepEqual(planLiquidation(positions, 1500, { type: "maintenance", equity: 1000 }), [{ symbol: PUT, side: "buy", qty: 2 }]);
    });

    test("shares covering a short call are only sold after the call is bought back", () => {
        const covered = [position("F", 100, 11.73), option(CALL, -1, 0.1)];
        assert.deepEqual(planLiquidation(covered, 300, { type: "maintenance", equity: 1000 }), [
            { symbol: CALL, side: "buy", qty: 1 }, { symbol: "F", side: "sell", qty: 100 }
        ]);
        // Shares beyond what the call needs are sold on their own
        assert.deepEqual(planLiquidation([position("F", 150, 11.73), option(CALL, -1, 0.1)], 100, { type: "maintenance", equity: 1000 }), [{ symbol: "F", side: "sell", qty: 30 }]);
    });

    test("with equity gone, short options close first, then everything else", () => {
        const trades = planLiquidation([position("F", 100, 11.73), option(CALL, -1, 0.1), option(PUT, -1, 0.05)], 10, { type: "maintenance", equity: -5 });
        assert.deepEqual(trades.map(({ symbol, side }) => `${side} ${symbol}`), [`buy ${CALL}`, `buy ${PUT}`, "sell F"]);
    });

    test("shorting needs the margin agreement, shorting on and $2,000", () => {
        assert.match(shortingBlocked({ hasMarginAgreement: false, noShorting: false, equity: 5000 })!, /margin account/);
        assert.match(shortingBlocked({ hasMarginAgreement: true, noShorting: true, equity: 5000 })!, /turned off/);
        assert.match(shortingBlocked({ hasMarginAgreement: true, noShorting: false, equity: 1999 })!, /\$2,000/);
        assert.equal(shortingBlocked({ hasMarginAgreement: true, noShorting: false, equity: 2000 }), null);
    });
});

describe("Interest and borrow fees", () => {
    test("margin interest: debit × rate / 360 a day, three days over a weekend", () => {
        // Alpaca's example: $5,000 overnight at 6.50% is $0.90 a day
        assert.equal(Math.round(marginInterest(5000, 0.065, 1) * 100) / 100, 0.90);
        assert.equal(Math.round(marginInterest(5000, 0.065, 3) * 100) / 100, 2.71);
        assert.equal(marginInterest(0, 0.065, 1), 0);
    });

    test("hard-to-borrow fees on the nearest round lot", () => {
        assert.equal(borrowFee({ qty: -150, price: 36, rate: 0.5, days: 1 }), 200 * 36 * 0.5 / 360);
        assert.equal(isRoundLot(200), true);
        assert.equal(isRoundLot(150), false);
    });
});
