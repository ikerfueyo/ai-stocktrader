const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { roundCents, computePositions, valueAccount, assessTrade, assessWithdrawal, planBuyIn } = require("./account");

// A trade as pg returns it: NUMERIC and DECIMAL columns come back as strings, and total is rounded to cents
const trade = (type, ticker, price, quantity) => ({
    ticker, type,
    price: price.toFixed(2),
    quantity: quantity.toFixed(6),
    total: roundCents(price * quantity).toFixed(2)
});
const buy = (ticker, price, quantity) => trade("BUY", ticker, price, quantity);
const sell = (ticker, price, quantity) => trade("SELL", ticker, price, quantity);

// What GET /account computes: total cash is the trades' cash ledger plus net deposits, rounded to cents
const account = (trades, prices, deposits = 0, options = {}) => {
    const { positions, cash } = computePositions(trades);
    const totalCash = roundCents(cash + deposits);
    return { positions, ...valueAccount({ positions, totalCash, prices, ...options }) };
};

// Trade totals and the reported figures are rounded to the cent, so allow a cent of difference (plus float noise)
const assertCents = (actual, expected, message = "", tolerance = 0.01) =>
    assert.ok(Math.abs(actual - expected) <= tolerance + 1e-9, `${message} expected ${expected}, got ${actual}`);

describe("Total cash is a plain ledger", () => {
    test("every sell credits its total and every buy debits it, short sales and covers included", () => {
        const trades = [buy("AAA", 100, 10), sell("BBB", 50, 20), sell("AAA", 110, 4), buy("BBB", 45, 5)];
        const { cash } = computePositions(trades);
        assertCents(cash, -1000 + 1000 + 440 - 225);
    });
});

describe("Equity = total cash + long market value - short market liability", () => {
    test("with no positions, equity is total cash, all of it available", () => {
        const result = account([], {}, 10000);
        assert.equal(result.equity, 10000);
        assert.equal(result.availableCash, 10000);
        assert.equal(result.restrictedCash, 0);
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
        // Once covered, the gain is realized and nothing is restricted any more
        assert.equal(fullyCovered.availableCash, fullyCovered.equity);
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
        assert.equal(result.shortLiability, 1200);
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

describe("Short collateral: 150% of short liability is restricted from total cash", () => {
    test("restricted cash follows the short's current value, and the rest is available", () => {
        const shorted = [sell("BBB", 100, 10)];
        const atOpen = account(shorted, { BBB: 100 }, 10000);
        assert.equal(atOpen.totalCash, 11000);
        assert.equal(atOpen.collateralRequirement, 1500);
        assert.equal(atOpen.restrictedCash, 1500);
        assert.equal(atOpen.availableCash, 9500);
        assert.equal(atOpen.marginStatus, "ok");

        const risen = account(shorted, { BBB: 200 }, 10000);
        assert.equal(risen.restrictedCash, 3000);
        assert.equal(risen.availableCash, 8000);

        const fallen = account(shorted, { BBB: 80 }, 10000);
        assert.equal(fallen.restrictedCash, 1200, "a falling price releases collateral");
        assert.equal(fallen.availableCash, 9800);
    });

    test("opening a short uses 50% of its value from available cash (its proceeds cover the other 100%)", () => {
        const before = account([], { BBB: 100 }, 10000);
        const after = account([sell("BBB", 100, 10)], { BBB: 100 }, 10000);
        assert.equal(before.availableCash - after.availableCash, 500);
    });

    test("the requirement changes neither total cash, equity nor unrealized P&L", () => {
        const trades = [buy("AAA", 100, 10), sell("BBB", 50, 20), sell("CCC", 30, 15)];
        for (const prices of [{ AAA: 90, BBB: 55, CCC: 20 }, { AAA: 130, BBB: 80, CCC: 45 }, { AAA: 10, BBB: 400, CCC: 1 }]) {
            const withCollateral = account(trades, prices, 1000);
            const withoutCollateral = account(trades, prices, 1000, { collateralRate: 0 });
            assert.equal(withCollateral.totalCash, withoutCollateral.totalCash);
            assert.equal(withCollateral.equity, withoutCollateral.equity);
            assert.equal(withCollateral.unrealizedPnl, withoutCollateral.unrealizedPnl);
        }
    });

    test("below 150% it's a margin call: available is $0 and the gap is a collateral shortfall", () => {
        // Total cash $1,500 against a $1,100 short: requirement $1,650 (ratio 1.36)
        const result = account([sell("BBB", 100, 10)], { BBB: 110 }, 500);
        assert.equal(result.marginStatus, "margin_call");
        assert.equal(result.availableCash, 0);
        assert.equal(result.restrictedCash, 1500);
        assert.equal(result.collateralShortfall, 150);
        assert.equal(result.availableCash + result.restrictedCash, result.totalCash);
    });

    test("below 130% the buy-in is due", () => {
        // Total cash $1,500 against a $1,200 short (ratio 1.25)
        const result = account([sell("BBB", 100, 10)], { BBB: 120 }, 500);
        assert.equal(result.marginStatus, "buy_in");
        assert.equal(result.collateralShortfall, 300);
    });

    test("negative total cash with no shorts is a margin call for the deficit, never negative available cash", () => {
        const result = account([buy("AAA", 100, 10)], { AAA: 100 });
        assert.equal(result.totalCash, -1000);
        assert.equal(result.availableCash, 0);
        assert.equal(result.restrictedCash, 0);
        assert.equal(result.collateralShortfall, 1000);
        assert.equal(result.marginStatus, "margin_call");
    });
});

// What the server sees: the history, net deposits and current prices
const assess = (trades, deposits, prices, newTrade, staleTickers = []) =>
    assessTrade({ transactions: trades, netTransfers: deposits, prices, staleTickers, trade: newTrade });
const withdraw = (trades, deposits, prices, amount, staleTickers = []) => {
    const { positions, cash } = computePositions(trades);
    return assessWithdrawal({ positions, totalCash: roundCents(cash + deposits), prices, staleTickers, amount });
};

describe("Which trades and withdrawals are allowed", () => {
    test("a buy may use all of available cash, and not a cent more", () => {
        assert.equal(assess([], 1000, {}, buy("AAA", 100, 10)).allowed, true);
        const tooMuch = assess([], 1000, {}, buy("AAA", 100, 10.0001));
        assert.equal(tooMuch.allowed, false);
        assert.equal(tooMuch.status, 400);
        assert.match(tooMuch.message, /Insufficient funds: buying AAA needs \$1,000\.01 available, but only \$1,000\.00 is/);
    });

    test("a new short needs 50% of its value available", () => {
        assert.equal(assess([], 500, {}, sell("BBB", 100, 10)).allowed, true);
        const tooBig = assess([], 500, {}, sell("BBB", 100, 10.01));
        assert.equal(tooBig.allowed, false);
        assert.match(tooBig.message, /Insufficient collateral: shorting BBB needs \$500\.50 available/);
    });

    test("covers use restricted cash, even with $0 available", () => {
        const shorted = [sell("BBB", 100, 10)];
        // $500 deposited plus $1,000 of proceeds exactly meets the $1,500 requirement
        assert.equal(account(shorted, { BBB: 100 }, 500).availableCash, 0);
        assert.equal(assess(shorted, 500, { BBB: 110 }, buy("BBB", 110, 5)).allowed, true);
        const afterCover = account([...shorted, buy("BBB", 110, 5)], { BBB: 110 }, 500);
        // Total cash $950 against a $550 short: $825 restricted, $125 available
        assert.equal(afterCover.availableCash, 125);
        assert.equal(afterCover.marginStatus, "ok");
    });

    test("a cover is allowed even when it costs more than total cash, and the deficit shows as a shortfall", () => {
        const shorted = [sell("BBB", 100, 10)];
        assert.equal(assess(shorted, 500, { BBB: 200 }, buy("BBB", 200, 10)).allowed, true);
        const covered = account([...shorted, buy("BBB", 200, 10)], {}, 500);
        assert.equal(covered.totalCash, -500);
        assert.equal(covered.availableCash, 0);
        assert.equal(covered.collateralShortfall, 500);
    });

    test("during a margin call only covers, sales of longs and deposits are allowed", () => {
        // $1,500 of total cash against a $1,100 short after BBB rises to $110: a $150 shortfall
        const trades = [buy("CCC", 10, 1), sell("BBB", 100, 10)];
        const prices = { BBB: 110, CCC: 10 };
        assert.equal(account(trades, prices, 510).marginStatus, "margin_call");
        assert.equal(assess(trades, 510, prices, sell("CCC", 10, 1)).allowed, true, "selling a long");
        assert.equal(assess(trades, 510, prices, buy("BBB", 110, 2)).allowed, true, "covering");
        const newLong = assess(trades, 510, prices, buy("AAA", 10, 1));
        assert.equal(newLong.allowed, false);
        assert.match(newLong.message, /Margin call: your account has a \$150\.00 collateral shortfall/);
        assert.equal(assess(trades, 510, prices, sell("BBB", 110, 1)).allowed, false, "adding to the short");
        assert.equal(withdraw(trades, 510, prices, 1).allowed, false, "withdrawing");
    });

    test("a flip is judged as a whole trade", () => {
        // Long 10 AAA with $0 of cash: a fresh short is refused, but selling 15 AAA closes 10 (+$1,000) and shorts 5 (+$500),
        // leaving $1,500 against a $750 requirement
        const long = [buy("AAA", 100, 10)];
        assert.equal(assess(long, 1000, { AAA: 100 }, sell("BBB", 100, 5)).allowed, false);
        assert.equal(assess(long, 1000, { AAA: 100 }, sell("AAA", 100, 15)).allowed, true);

        // Short 10 BBB with $0 available: buying 12 covers 10 and buys 2 long ($300 left), but buying 20 would need $500 more
        const short = [sell("BBB", 100, 10)];
        assert.equal(assess(short, 500, { BBB: 100 }, buy("BBB", 100, 12)).allowed, true);
        assert.equal(assess(short, 500, { BBB: 100 }, buy("BBB", 100, 20)).allowed, false);
    });

    test("a short without a current price blocks risk-increasing actions, but not covers or sales", () => {
        const trades = [buy("CCC", 10, 1), sell("BBB", 100, 10)];
        const lastKnown = { BBB: 100, CCC: 10 };
        const stale = ["BBB"];
        const blocked = assess(trades, 10000, lastKnown, buy("AAA", 10, 1), stale);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.status, 502);
        assert.match(blocked.message, /Couldn't get a current price for BBB/);
        assert.equal(withdraw(trades, 10000, lastKnown, 1, stale).status, 502);
        assert.equal(assess(trades, 10000, lastKnown, buy("BBB", 100, 1), stale).allowed, true, "covering");
        assert.equal(assess(trades, 10000, lastKnown, sell("CCC", 10, 1), stale).allowed, true, "selling a long");
        // Adding to the stale short is priced at the trade price
        assert.equal(assess(trades, 10000, lastKnown, sell("BBB", 100, 1), stale).allowed, true);
    });

    test("withdrawals come only from available cash, not from short collateral", () => {
        const shorted = [sell("BBB", 100, 10)];
        assert.equal(withdraw(shorted, 10000, { BBB: 100 }, 9500).allowed, true);
        const tooMuch = withdraw(shorted, 10000, { BBB: 100 }, 9500.01);
        assert.equal(tooMuch.allowed, false);
        assert.match(tooMuch.message, /only \$9,500\.00 is available \(\$1,500\.00 is held as short collateral\)/);
    });
});

// Apply a buy-in plan's trades to a history, as the server does
const buyIn = (trades, deposits, prices, staleTickers = []) => {
    const { positions, cash } = computePositions(trades);
    return planBuyIn({ positions, totalCash: roundCents(cash + deposits), prices, staleTickers });
};
const asStored = ({ type, ticker, price, quantity, total }) =>
    ({ type, ticker, price: price.toFixed(2), quantity: quantity.toFixed(6), total: total.toFixed(2) });

describe("Automatic buy-in below 130%", () => {
    test("nothing happens at 130% or above, even in a margin call", () => {
        // Total cash $1,500 against a $1,150 short: ratio 1.304
        const shorted = [sell("BBB", 100, 10)];
        assert.equal(account(shorted, { BBB: 115 }, 500).marginStatus, "margin_call");
        assert.deepEqual(buyIn(shorted, 500, { BBB: 115 }).trades, []);
    });

    test("below 130%, it covers the minimum needed to get back to 150%", () => {
        // Total cash $1,500 against a $1,200 short: a $300 shortfall, which takes about $600 of covers
        const shorted = [sell("BBB", 100, 10)];
        const { trades } = buyIn(shorted, 500, { BBB: 120 });
        assert.equal(trades.length, 1);
        assert.equal(trades[0].type, "BUY");
        assert.ok(trades[0].total >= 600 && trades[0].total <= 600 + 0.05, `covered ${trades[0].total}`);
        const after = account([...shorted, ...trades.map(asStored)], { BBB: 120 }, 500);
        assert.equal(after.marginStatus, "ok");
        assert.equal(after.collateralShortfall, 0);
        assert.ok(after.collateralRatio >= 1.5);
    });

    test("covers every short by the same fraction", () => {
        // Total cash $3,000 against $2,600 of shorts (ratio 1.15)
        const shorted = [sell("BBB", 100, 10), sell("CCC", 50, 20)];
        const { trades } = buyIn(shorted, 1000, { BBB: 130, CCC: 65 });
        const fractions = trades.map(({ ticker, quantity }) => quantity / (ticker === "BBB" ? 10 : 20));
        assert.equal(trades.length, 2);
        assert.ok(Math.abs(fractions[0] - fractions[1]) < 1e-6, `fractions ${fractions}`);
        assert.equal(account([...shorted, ...trades.map(asStored)], { BBB: 130, CCC: 65 }, 1000).marginStatus, "ok");
    });

    test("below 100%, it covers every short, then sells longs pro rata to clear negative cash", () => {
        // Total cash $1,500 against a $2,000 short: covering all of it leaves -$500, so $500 of AAA is sold
        const trades = [buy("AAA", 50, 10), sell("BBB", 100, 10)];
        const plan = buyIn(trades, 1000, { AAA: 60, BBB: 200 });
        assert.deepEqual(plan.trades.map(({ type, ticker }) => `${type} ${ticker}`), ["BUY BBB", "SELL AAA"]);
        assert.equal(plan.trades[0].quantity, 10);
        assert.ok(plan.trades[1].quantity <= 10);
        assert.equal(plan.remainingDeficit, 0);
        const after = account([...trades, ...plan.trades.map(asStored)], { AAA: 60, BBB: 200 }, 1000);
        assert.ok(after.totalCash >= 0 && after.totalCash <= 0.1, `total cash ${after.totalCash}`);
        assert.equal(after.marginStatus, "ok");
    });

    test("if selling every long isn't enough, the rest is reported as a deficit", () => {
        const trades = [buy("AAA", 50, 10), sell("BBB", 100, 10)];
        const plan = buyIn(trades, 1000, { AAA: 10, BBB: 200 });
        assert.equal(plan.trades[1].quantity, 10);
        assert.equal(plan.remainingDeficit, 400);
    });

    test("nothing is bought in while a short has no current price", () => {
        assert.deepEqual(buyIn([sell("BBB", 100, 10)], 500, { BBB: 120 }, ["BBB"]).trades, []);
    });
});

// Seeded so a failure can be reproduced
const random = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("Randomized trading (600 steps over 3 tickers, with the server's rules and buy-ins)", () => {
    const next = random(42);
    const tickers = ["AAA", "BBB", "CCC"];
    const prices = { AAA: 100, BBB: 50, CCC: 20 };
    const trades = [];
    const deposits = 5000;
    const steps = [];
    let rejected = 0;
    let buyIns = 0;
    for (let i = 0; i < 600; i++) {
        const ticker = tickers[Math.floor(next() * tickers.length)];
        const before = account(trades, { ...prices }, deposits);
        // Move the price up to ±15%, then try to trade 0.5 to 40 shares at the new price
        const oldPrice = prices[ticker];
        prices[ticker] = roundCents(Math.max(1, oldPrice * (0.85 + next() * 0.3)));
        const moved = account(trades, { ...prices }, deposits);
        const quantity = Math.round((0.5 + next() * 39.5) * 1e6) / 1e6;
        const attempt = (next() < 0.5 ? buy : sell)(ticker, prices[ticker], quantity);
        let traded = moved;
        if (assessTrade({ transactions: trades, netTransfers: deposits, prices: { ...prices }, trade: attempt }).allowed) {
            trades.push(attempt);
            traded = account(trades, { ...prices }, deposits);
        } else {
            rejected++;
        }
        const plan = buyIn(trades, deposits, { ...prices });
        if (plan.trades.length > 0) buyIns++;
        trades.push(...plan.trades.map(asStored));
        const after = account(trades, { ...prices }, deposits);
        const held = before.positions.find(position => position.ticker === ticker)?.quantity ?? 0;
        steps.push({ before, moved, traded, after, held, priceChange: prices[ticker] - oldPrice, buyInTrades: plan.trades.length, prices: { ...prices }, step: i });
    }

    test("the run exercised shorts, rejections and buy-ins", () => {
        assert.ok(steps.some(({ after }) => after.positions.some(({ quantity }) => quantity < 0)), "no shorts");
        assert.ok(rejected > 0, "no rejected trades");
        assert.ok(buyIns > 0, "no buy-ins");
    });

    test("a price move changes equity and unrealized P&L by exactly shares held × price change", () => {
        for (const { before, moved, held, priceChange, step } of steps) {
            assertCents(moved.equity - before.equity, held * priceChange, `step ${step} equity:`);
            assertCents(moved.unrealizedPnl - before.unrealizedPnl, held * priceChange, `step ${step} P&L:`);
        }
    });

    test("trades and buy-ins at the market price never create or destroy equity", () => {
        for (const { moved, traded, after, buyInTrades, step } of steps) {
            assertCents(traded.equity, moved.equity, `step ${step} trade:`);
            assertCents(after.equity, traded.equity, `step ${step} buy-in:`, 0.01 + 0.005 * buyInTrades);
        }
    });

    test("equity and P&L match the definitions, computed independently from the open positions", () => {
        for (const { after, prices: pricesNow, step } of steps) {
            let longValue = 0;
            let longCostBasis = 0;
            let shortProceeds = 0;
            let shortLiability = 0;
            for (const { ticker, quantity, avgCost } of after.positions) {
                if (quantity > 0) {
                    longValue += quantity * pricesNow[ticker];
                    longCostBasis += quantity * avgCost;
                } else {
                    shortProceeds += -quantity * avgCost;
                    shortLiability += -quantity * pricesNow[ticker];
                }
            }
            assertCents(after.equity, after.totalCash + longValue - shortLiability, `step ${step} equity:`);
            assertCents(after.unrealizedPnl, (longValue - longCostBasis) + (shortProceeds - shortLiability), `step ${step} P&L:`);
        }
    });

    test("total cash splits into available and restricted cash, and available is never negative", () => {
        for (const { after, step } of steps) {
            const requirement = after.collateralRequirement;
            // Both figures are rounded to the cent, so 1.5 × the rounded liability can be off by 1.5 cents
            assertCents(requirement, 1.5 * after.shortLiability, `step ${step} requirement:`, 0.015);
            assert.ok(after.availableCash >= 0, `step ${step}: available ${after.availableCash}`);
            assert.ok(after.restrictedCash <= requirement + 0.01, `step ${step}: restricted ${after.restrictedCash} > ${requirement}`);
            assertCents(after.collateralShortfall, Math.max(0, requirement - after.totalCash), `step ${step} shortfall:`);
            if (after.totalCash >= 0) {
                assertCents(after.availableCash + after.restrictedCash, after.totalCash, `step ${step} split:`);
            }
        }
    });

    test("after each step's buy-in check, the account is never left below 130%", () => {
        for (const { after, step } of steps) {
            assert.notEqual(after.marginStatus, "buy_in", `step ${step}: ratio ${after.collateralRatio}`);
        }
    });

    test("the requirement never changes total cash, equity or P&L", () => {
        for (const { after, prices: pricesNow, step } of steps) {
            const { positions } = after;
            const withoutCollateral = valueAccount({ positions, totalCash: after.totalCash, prices: pricesNow, collateralRate: 0 });
            assert.equal(withoutCollateral.equity, after.equity, `step ${step}`);
            assert.equal(withoutCollateral.unrealizedPnl, after.unrealizedPnl, `step ${step}`);
        }
    });

    test("closing everything at the market price leaves equity unchanged, all of it available, with no unrealized P&L", () => {
        const open = account(trades, { ...prices }, deposits);
        const closing = open.positions.map(({ ticker, quantity }) => (quantity > 0 ? sell : buy)(ticker, prices[ticker], Math.abs(quantity)));
        const closed = account([...trades, ...closing], { ...prices }, deposits);
        assert.equal(closed.positions.length, 0);
        assert.equal(closed.unrealizedPnl, 0);
        // Up to half a cent of rounding per closing trade
        assertCents(closed.equity, open.equity, "", 0.01 + 0.005 * closing.length);
        assert.equal(closed.availableCash, Math.max(0, closed.totalCash));
        assert.equal(closed.restrictedCash, 0);
    });
});
