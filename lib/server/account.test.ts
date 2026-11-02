import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { roundCents, computePositions, valueAccount, fillPrice, planDividends, positionsAt, type Prices, type Trade } from "./account";

// A trade as pg returns it: NUMERIC and DECIMAL columns come back as strings, and total is rounded to cents
const trade = (type: "BUY" | "SELL", ticker: string, price: number, quantity: number): Trade => ({
    ticker, type,
    price: price.toFixed(6),
    quantity: quantity.toFixed(6),
    total: roundCents(price * quantity).toFixed(2)
});
const buy = (ticker: string, price: number, quantity: number) => trade("BUY", ticker, price, quantity);
const sell = (ticker: string, price: number, quantity: number) => trade("SELL", ticker, price, quantity);

// What GET /api/account computes: total cash is the trades' cash ledger plus net deposits, rounded to cents
const account = (trades: Trade[], prices: Prices, deposits = 0, options: { staleTickers?: string[] } = {}) => {
    const { positions, cash } = computePositions(trades);
    const totalCash = roundCents(cash + deposits);
    return { positions, ...valueAccount({ positions, totalCash, prices, ...options }) };
};

// Trade totals and the reported figures are rounded to the cent, so allow a cent of difference (plus float noise)
const assertCents = (actual: number, expected: number, message = "", tolerance = 0.01) =>
    assert.ok(Math.abs(actual - expected) <= tolerance + 1e-9, `${message} expected ${expected}, got ${actual}`);

describe("Total cash is a plain ledger", () => {
    test("every sell credits its total and every buy debits it, short sales and covers included", () => {
        const trades = [buy("AAA", 100, 10), sell("BBB", 50, 20), sell("AAA", 110, 4), buy("BBB", 45, 5)];
        const { cash } = computePositions(trades);
        assertCents(cash, -1000 + 1000 + 440 - 225);
    });
});

describe("Equity = total cash + long market value - short market liability", () => {
    test("with no positions, equity is total cash", () => {
        const result = account([], {}, 10000);
        assert.equal(result.equity, 10000);
        assert.equal(result.longMarketValue + result.shortMarketValue, 0);
    });

    test("a long adds its market value", () => {
        // Paid $1,000 for 10 shares now worth $120 each
        const result = account([buy("AAA", 100, 10)], { AAA: 120 }, 10000);
        assert.equal(result.totalCash, 9000);
        assert.equal(result.equity, 9000 + 10 * 120);
    });

    test("a short's sale proceeds are part of total cash, and its market liability is subtracted", () => {
        // Sold 10 borrowed shares for $1,000; buying them back now would cost $800
        const result = account([sell("BBB", 100, 10)], { BBB: 80 }, 10000);
        assert.equal(result.totalCash, 10000 + 1000);
        assert.equal(result.equity, 11000 - 10 * 80);
    });

    test("a mixed portfolio matches the formula", () => {
        const trades = [
            buy("AAA", 50, 10),   // $500
            buy("AAA", 60, 5),    // $300, so 15 shares at $53.33 average
            sell("BBB", 25, 20)   // short 20 for $500 of proceeds
        ];
        const result = account(trades, { AAA: 70, BBB: 30 }, 5000);
        const totalCash = 5000 - 800 + 500;
        assert.equal(result.totalCash, totalCash);
        assert.equal(result.equity, totalCash + 15 * 70 - 20 * 30);
        // Equity is also net deposits plus realized (none here) and unrealized P&L
        assert.equal(result.equity, 5000 + result.unrealizedPnl);
    });

    test("opening a short at the market price neither creates nor destroys equity", () => {
        const before = account([buy("AAA", 100, 10)], { AAA: 100, BBB: 50 }, 10000);
        const after = account([buy("AAA", 100, 10), sell("BBB", 50, 40)], { AAA: 100, BBB: 50 }, 10000);
        assert.equal(after.totalCash, before.totalCash + 2000);
        assert.equal(after.equity, before.equity);
    });

    test("adding to a short at the market price doesn't change equity", () => {
        const trades = [sell("BBB", 50, 40)];
        const before = account(trades, { BBB: 45 }, 10000);
        const after = account([...trades, sell("BBB", 45, 10)], { BBB: 45 }, 10000);
        assert.equal(after.equity, before.equity);
    });

    test("covering a short at the market price, partly or fully, neither creates nor destroys equity", () => {
        const opened = [sell("BBB", 50, 40)];
        const atMarket = { BBB: 35 };
        const open = account(opened, atMarket, 10000);
        const partlyCovered = account([...opened, buy("BBB", 35, 15)], atMarket, 10000);
        const fullyCovered = account([...opened, buy("BBB", 35, 15), buy("BBB", 35, 25)], atMarket, 10000);
        assert.equal(open.equity, 10000 + 40 * (50 - 35));
        assert.equal(partlyCovered.equity, open.equity);
        assert.equal(fullyCovered.equity, open.equity);
        // Once covered, the gain is realized: it's all cash
        assert.equal(fullyCovered.totalCash, fullyCovered.equity);
        assert.equal(fullyCovered.unrealizedPnl, 0);
    });

    test("covering a short at a loss keeps equity and leaves the loss in total cash", () => {
        const opened = [sell("BBB", 50, 40)];
        const open = account(opened, { BBB: 60 }, 10000);
        const covered = account([...opened, buy("BBB", 60, 40)], { BBB: 60 }, 10000);
        assert.equal(open.equity, 10000 - 40 * 10);
        assert.equal(covered.equity, open.equity);
        assert.equal(covered.totalCash, 10000 - 400);
    });

    test("flipping long to short or short to long at the market price doesn't change equity", () => {
        const long = [buy("AAA", 100, 10)];
        const beforeFlip = account(long, { AAA: 110 }, 5000);
        const flippedShort = account([...long, sell("AAA", 110, 15)], { AAA: 110 }, 5000);
        assert.equal(flippedShort.positions[0].quantity, -5);
        assert.equal(flippedShort.equity, beforeFlip.equity);

        const flippedLong = account([...long, sell("AAA", 110, 15), buy("AAA", 105, 12)], { AAA: 105 }, 5000);
        const beforeSecondFlip = account([...long, sell("AAA", 110, 15)], { AAA: 105 }, 5000);
        assert.equal(flippedLong.positions[0].quantity, 7);
        assert.equal(flippedLong.equity, beforeSecondFlip.equity);
    });

    test("deposits and withdrawals change equity by exactly their amount", () => {
        const trades = [buy("AAA", 100, 10), sell("BBB", 50, 20)];
        const prices = { AAA: 90, BBB: 55 };
        assert.equal(account(trades, prices, 2500).equity - account(trades, prices, 1000).equity, 1500);
    });

    test("a position without a price is valued at its average cost and flagged, so its proceeds don't inflate equity", () => {
        const result = account([buy("AAA", 100, 10), sell("BBB", 50, 20)], { AAA: 120 }, 10000);
        assert.deepEqual(result.missingPrices, ["BBB"]);
        assert.equal(result.equity, account([buy("AAA", 100, 10), sell("BBB", 50, 20)], { AAA: 120, BBB: 50 }, 10000).equity);
    });

    test("a stale ticker is valued at the price given (its last known price) and flagged", () => {
        const result = account([sell("BBB", 50, 20)], { BBB: 60 }, 10000, { staleTickers: ["BBB"] });
        assert.deepEqual(result.missingPrices, ["BBB"]);
        assert.equal(result.shortMarketValue, 1200);
    });
});

describe("Unrealized P&L = Σ long (market value - cost basis) + Σ short (sale proceeds - market liability)", () => {
    test("long: market value minus cost basis, averaged over buys", () => {
        // Cost basis $1,000 + $1,100 = $2,100; worth 20 × $120 = $2,400
        const result = account([buy("AAA", 100, 10), buy("AAA", 110, 10)], { AAA: 120 });
        assert.equal(result.unrealizedPnl, 2400 - 2100);
    });

    test("long at a loss", () => {
        const result = account([buy("AAA", 100, 10)], { AAA: 75.5 });
        assert.equal(result.unrealizedPnl, 755 - 1000);
    });

    test("short: original sale proceeds minus current market liability", () => {
        // Proceeds $1,000 + $900 = $1,900
        const trades = [sell("BBB", 100, 10), sell("BBB", 90, 10)];
        assert.equal(account(trades, { BBB: 80 }).unrealizedPnl, 1900 - 1600, "price fell: a gain");
        assert.equal(account(trades, { BBB: 110 }).unrealizedPnl, 1900 - 2200, "price rose: a loss");
    });

    test("a partial close keeps the remaining shares' cost basis, and the realized part isn't counted", () => {
        // 6 shares left with a $600 cost basis; the $120 gain on the 4 sold is realized
        const result = account([buy("AAA", 100, 10), sell("AAA", 130, 4)], { AAA: 130 });
        assert.equal(result.unrealizedPnl, 6 * 130 - 600);
    });

    test("a partial cover keeps the remaining shares' proceeds", () => {
        const result = account([sell("BBB", 100, 10), buy("BBB", 80, 4)], { BBB: 70 });
        assert.equal(result.unrealizedPnl, 6 * 100 - 6 * 70);
    });

    test("after a flip, the new side's basis is the flip price", () => {
        // Long 10 at $100, sold 15 at $110: short 5 with $550 of proceeds
        const result = account([buy("AAA", 100, 10), sell("AAA", 110, 15)], { AAA: 100 });
        assert.equal(result.unrealizedPnl, 550 - 500);
    });

    test("aggregates across all open positions, long and short", () => {
        const trades = [buy("AAA", 100, 10), sell("BBB", 50, 20), buy("CCC", 20, 50)];
        const prices = { AAA: 110, BBB: 55, CCC: 18 };
        // AAA long +$100, BBB short -$100, CCC long -$100
        assert.equal(account(trades, prices).unrealizedPnl, (1100 - 1000) + (1000 - 1100) + (900 - 1000));
    });

    test("fractional shares", () => {
        const result = account([buy("AAA", 333.33, 0.5), sell("BBB", 12.5, 2.25)], { AAA: 340, BBB: 10 });
        // P&L uses avgCost × shares = $166.665, not the rounded stored total
        assertCents(result.unrealizedPnl, (170 - 166.665) + (28.125 - 22.5));
    });

    test("closed positions contribute nothing", () => {
        const result = account([buy("AAA", 100, 10), sell("AAA", 120, 10), sell("BBB", 50, 5), buy("BBB", 40, 5)], {});
        assert.equal(result.positions.length, 0);
        assert.equal(result.unrealizedPnl, 0);
    });

    test("a position without a price contributes nothing (valued at its cost)", () => {
        const result = account([buy("AAA", 100, 10), sell("BBB", 50, 20)], { AAA: 120 });
        assert.equal(result.unrealizedPnl, 200);
    });
});

// One step of the randomized run: the account before the price move, after it and after the trade
interface Step {
    before: ReturnType<typeof account>;
    moved: ReturnType<typeof account>;
    after: ReturnType<typeof account>;
    held: number;
    priceChange: number;
    prices: Prices;
    step: number;
}

// Seeded so a failure can be reproduced
const random = (seed: number) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("Randomized trading (600 steps over 3 tickers, longs, shorts and flips)", () => {
    const next = random(42);
    const tickers = ["AAA", "BBB", "CCC"];
    const prices: Prices = { AAA: 100, BBB: 50, CCC: 20 };
    const trades: Trade[] = [];
    const deposits = 5000;
    const steps: Step[] = [];
    for (let i = 0; i < 600; i++) {
        const ticker = tickers[Math.floor(next() * tickers.length)];
        const before = account(trades, { ...prices }, deposits);
        // Move the price up to ±15%, then trade 0.5 to 40 shares at the new price
        const oldPrice = prices[ticker];
        prices[ticker] = roundCents(Math.max(1, oldPrice * (0.85 + next() * 0.3)));
        const moved = account(trades, { ...prices }, deposits);
        const quantity = Math.round((0.5 + next() * 39.5) * 1e6) / 1e6;
        trades.push((next() < 0.5 ? buy : sell)(ticker, prices[ticker], quantity));
        const after = account(trades, { ...prices }, deposits);
        const held = before.positions.find(position => position.ticker === ticker)?.quantity ?? 0;
        steps.push({ before, moved, after, held, priceChange: prices[ticker] - oldPrice, prices: { ...prices }, step: i });
    }

    test("the run exercised longs and shorts", () => {
        assert.ok(steps.some(({ after }) => after.positions.some(({ quantity }) => quantity < 0)), "no shorts");
        assert.ok(steps.some(({ after }) => after.positions.some(({ quantity }) => quantity > 0)), "no longs");
    });

    test("a price move changes equity and unrealized P&L by exactly shares held × price change", () => {
        for (const { before, moved, held, priceChange, step } of steps) {
            assertCents(moved.equity - before.equity, held * priceChange, `step ${step} equity:`);
            assertCents(moved.unrealizedPnl - before.unrealizedPnl, held * priceChange, `step ${step} P&L:`);
        }
    });

    test("trades at the market price never create or destroy equity", () => {
        for (const { moved, after, step } of steps) assertCents(after.equity, moved.equity, `step ${step} trade:`);
    });

    test("equity and P&L match the definitions, computed independently from the open positions", () => {
        for (const { after, prices: pricesNow, step } of steps) {
            let longValue = 0;
            let longCostBasis = 0;
            let shortProceeds = 0;
            let shortValue = 0;
            for (const { ticker, quantity, avgCost } of after.positions) {
                if (quantity > 0) {
                    longValue += quantity * pricesNow[ticker];
                    longCostBasis += quantity * avgCost;
                } else {
                    shortProceeds += -quantity * avgCost;
                    shortValue += -quantity * pricesNow[ticker];
                }
            }
            assertCents(after.equity, after.totalCash + longValue - shortValue, `step ${step} equity:`);
            assertCents(after.unrealizedPnl, (longValue - longCostBasis) + (shortProceeds - shortValue), `step ${step} P&L:`);
        }
    });

    test("closing everything at the market price leaves equity unchanged, with no unrealized P&L", () => {
        const open = account(trades, { ...prices }, deposits);
        const closing = open.positions.map(({ ticker, quantity }) => (quantity > 0 ? sell : buy)(ticker, prices[ticker], Math.abs(quantity)));
        const closed = account([...trades, ...closing], { ...prices }, deposits);
        assert.equal(closed.positions.length, 0);
        assert.equal(closed.unrealizedPnl, 0);
        // Up to half a cent of rounding per closing trade
        assertCents(closed.equity, open.equity, "", 0.01 + 0.005 * closing.length);
    });
});

describe("Market orders fill at the ask (buys) and the bid (sells)", () => {
    const quoted = { price: 100, bid: 99.98, ask: 100.02, spread: "quoted" as const };

    test("quoted, simulated and missing bid/ask", () => {
        assert.deepEqual(fillPrice("BUY", quoted), { price: 100.02, fillPolicy: "ASK" });
        assert.deepEqual(fillPrice("SELL", quoted), { price: 99.98, fillPolicy: "BID" });
        assert.deepEqual(fillPrice("BUY", { ...quoted, spread: "simulated" }), { price: 100.02, fillPolicy: "SIM_ASK" });
        assert.deepEqual(fillPrice("SELL", { price: 100, bid: null, ask: null, spread: "none" }), { price: 100, fillPolicy: "LAST" });
    });

    test("a round trip at the bid and ask costs the spread, which comes out of equity", () => {
        const { price: buyPrice } = fillPrice("BUY", quoted);
        const { price: sellPrice } = fillPrice("SELL", quoted);
        const closed = account([buy("AAA", buyPrice, 10), sell("AAA", sellPrice, 10)], { AAA: 100 }, 5000);
        assertCents(closed.equity, 5000 - 10 * (buyPrice - sellPrice));
    });
});

// A trade on a given day, at 11:00 Eastern
const on = (day: string, stored: Trade): Trade => ({ ...stored, date: `${day}T15:00:00Z` });

describe("Splits", () => {
    const split = { ticker: "NVDA", exDate: "2024-06-10", factor: 10 };
    const asOf = new Date("2024-07-01T15:00:00Z");

    test("a split multiplies shares and divides the average cost, so cost basis and cash don't change", () => {
        const { positions, cash } = computePositions([on("2024-05-01", buy("NVDA", 900, 10))], [split], { asOf });
        assert.equal(positions[0].quantity, 100);
        assertCents(positions[0].avgCost, 90);
        assertCents(cash, -9000);
    });

    test("a sale after the split is of post-split shares, and doesn't flip to a short", () => {
        const trades = [on("2024-05-01", buy("NVDA", 900, 10)), on("2024-06-11", sell("NVDA", 120, 100))];
        assert.deepEqual(computePositions(trades, [split], { asOf }).positions, []);
    });

    test("trades on or after the split date are already in post-split shares", () => {
        const { positions } = computePositions([on("2024-06-10", buy("NVDA", 120, 5))], [split], { asOf });
        assert.equal(positions[0].quantity, 5);
    });

    test("a split doesn't apply before its date, or to positions closed before it", () => {
        assert.equal(computePositions([on("2024-05-01", buy("NVDA", 900, 10))], [split], { asOf: new Date("2024-06-07T15:00:00Z") }).positions[0].quantity, 10);
        const closed = [on("2024-05-01", buy("NVDA", 900, 10)), on("2024-05-02", sell("NVDA", 910, 10)), on("2024-06-12", buy("NVDA", 120, 3))];
        assert.equal(computePositions(closed, [split], { asOf }).positions[0].quantity, 3);
    });

    test("a short is split too, and a reverse split works the same way", () => {
        const shorted = computePositions([on("2024-05-01", sell("NVDA", 900, 10))], [split], { asOf }).positions[0];
        assert.equal(shorted.quantity, -100);
        assertCents(shorted.avgCost, 90);
        const reverse = computePositions([on("2024-05-01", buy("XYZ", 2, 1000))], [{ ticker: "XYZ", exDate: "2024-06-03", factor: 0.1 }], { asOf }).positions[0];
        assert.equal(reverse.quantity, 100);
        assertCents(reverse.avgCost, 20);
    });

    test("a split never changes equity at split-adjusted prices", () => {
        const trades = [on("2024-05-01", buy("NVDA", 900, 10)), on("2024-05-01", sell("AMD", 150, 20))];
        const before = computePositions(trades, [], { asOf });
        const after = computePositions(trades, [split], { asOf });
        const equityBefore = valueAccount({ positions: before.positions, totalCash: roundCents(before.cash + 20000), prices: { NVDA: 1200, AMD: 160 } }).equity;
        const equityAfter = valueAccount({ positions: after.positions, totalCash: roundCents(after.cash + 20000), prices: { NVDA: 120, AMD: 160 } }).equity;
        assert.equal(equityAfter, equityBefore);
    });

    test("a new (undated) trade after a split is in post-split shares", () => {
        const { positions, cash } = computePositions([on("2024-05-01", buy("NVDA", 900, 10))], [split]);
        const after = computePositions([on("2024-05-01", buy("NVDA", 900, 10)), sell("NVDA", 120, 100)], [split]);
        assert.equal(positions[0].quantity, 100);
        assert.equal(after.positions.length, 0, "selling the 100 post-split shares closes the position");
        assert.equal(after.cash, cash + 12000);
    });
});

describe("Dividends", () => {
    const dividend = { ticker: "AAPL", exDate: "2026-08-10", paymentDate: "2026-08-13", amount: 0.27 };
    const asOf = new Date("2026-08-20T15:00:00Z");
    const plan = (trades: Trade[], options: { posted?: string[]; asOf?: Date } = {}) =>
        planDividends({ transactions: trades, splits: [], dividends: [dividend], posted: new Set(options.posted ?? []), asOf: options.asOf ?? asOf });

    test("a long held at the ex-date's open receives it", () => {
        assert.deepEqual(plan([on("2026-08-07", buy("AAPL", 230, 10))]), [{ type: "DIVIDEND_IN", ticker: "AAPL", exDate: "2026-08-10", shares: 10, perShare: 0.27, total: 2.7 }]);
    });

    test("a short pays it", () => {
        const [posting] = plan([on("2026-08-07", sell("AAPL", 230, 10))]);
        assert.equal(posting.type, "DIVIDEND_OUT");
        assert.equal(posting.total, 2.7);
    });

    test("buying on the ex-date, or selling before it, gets nothing", () => {
        assert.deepEqual(plan([on("2026-08-10", buy("AAPL", 230, 10))]), []);
        assert.deepEqual(plan([on("2026-08-03", buy("AAPL", 230, 10)), on("2026-08-07", sell("AAPL", 231, 10))]), []);
    });

    test("selling on the ex-date still gets it", () => {
        assert.equal(plan([on("2026-08-03", buy("AAPL", 230, 10)), on("2026-08-10", sell("AAPL", 229, 10))]).length, 1);
    });

    test("isn't posted before its payment date, or twice", () => {
        assert.deepEqual(plan([on("2026-08-07", buy("AAPL", 230, 10))], { asOf: new Date("2026-08-12T15:00:00Z") }), []);
        assert.deepEqual(plan([on("2026-08-07", buy("AAPL", 230, 10))], { posted: ["AAPL|2026-08-10"] }), []);
    });

    test("positionsAt uses split-adjusted shares", () => {
        const positions = positionsAt([on("2024-05-01", buy("NVDA", 900, 10))], [{ ticker: "NVDA", exDate: "2024-06-10", factor: 10 }], "2024-06-11");
        assert.equal(positions[0].quantity, 100);
    });
});

describe("Realized P&L", () => {
    test("buying 10 at $100 and selling 5 at $120 realizes $100; the rest keeps its cost basis", () => {
        const trades = [buy("AAA", 100, 10), sell("AAA", 120, 5)];
        const { realizedPnl, realized, positions } = computePositions(trades);
        assert.equal(realizedPnl, 100);
        assert.deepEqual(realized, [null, 100]);
        assert.equal(positions[0].avgCost, 100);
        assert.equal(account(trades, { AAA: 120 }, 5000).unrealizedPnl, 100);
    });

    test("covering a short below its sale price realizes a gain", () => {
        assert.equal(computePositions([sell("BBB", 50, 10), buy("BBB", 40, 10)]).realizedPnl, 100);
    });

    test("a flip realizes only the closed part, and the new side starts at the trade price", () => {
        const { realizedPnl, positions } = computePositions([buy("AAA", 100, 10), sell("AAA", 90, 15)]);
        assert.equal(realizedPnl, -100);
        assert.deepEqual(positions[0], { ticker: "AAA", quantity: -5, avgCost: 90 });
    });

    test("equity = net deposits + realized P&L + unrealized P&L", () => {
        const trades = [buy("AAA", 100, 10), sell("AAA", 130, 4), sell("BBB", 50, 20), buy("BBB", 45, 5), buy("AAA", 120, 3), sell("CCC", 10, 100)];
        const prices = { AAA: 125, BBB: 47, CCC: 12 };
        const { realizedPnl } = computePositions(trades);
        const result = account(trades, prices, 10000);
        assertCents(result.equity, 10000 + realizedPnl + result.unrealizedPnl, "", 0.02);
    });
});
