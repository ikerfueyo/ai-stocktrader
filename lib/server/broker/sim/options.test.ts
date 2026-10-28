import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { contractMultiplier, contractName, daysToExpiration, isOptionSymbol, optionSymbol, parseOptionSymbol } from "../../../options";
import {
    blackScholes, deliveryFor, earlyAssignmentLikely, expirationOutcome, medianVolatility, mlegCoverageError, mlegNetPrice, modelOptionQuote, optionRequirement,
    optionTick, requiredLevel, sharesCoveringCalls, validateOptionOrder, type ChainContract, type OptionHolding, type OptionLeg
} from "./options";
import { easternTime } from "../../../marketHours";

const near = (actual: number, expected: number, tolerance = 1e-3) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} isn't ${expected}`);

describe("Contract symbols", () => {
    test("OCC symbols parse and format both ways", () => {
        assert.deepEqual(parseOptionSymbol("F261120C00012000"), { underlying: "F", expiration: "2026-11-20", type: "call", strike: 12 });
        assert.deepEqual(parseOptionSymbol("AAPL270115P00187500"), { underlying: "AAPL", expiration: "2027-01-15", type: "put", strike: 187.5 });
        assert.equal(optionSymbol({ underlying: "AAPL", expiration: "2027-01-15", type: "put", strike: 187.5 }), "AAPL270115P00187500");
        assert.equal(parseOptionSymbol("BRK.B"), null);
        assert.equal(isOptionSymbol("F"), false);
    });

    test("a contract is 100 shares, named as Alpaca names it", () => {
        assert.equal(contractMultiplier("F261120C00012000"), 100);
        assert.equal(contractMultiplier("F"), 1);
        assert.equal(contractName("F261120C00012000"), "F Nov 20 2026 12 Call");
        assert.equal(daysToExpiration("2026-11-20", "2026-10-28"), 23);
    });
});

describe("Pricing", () => {
    test("Black-Scholes matches the textbook values and put-call parity", () => {
        const inputs = { price: 100, strike: 100, years: 1, volatility: 0.2, rate: 0.05 };
        const call = blackScholes({ type: "call", ...inputs });
        const put = blackScholes({ type: "put", ...inputs });
        near(call.price, 10.4506);
        near(put.price, 5.5735);
        near(call.delta, 0.6368);
        near(call.price - put.price, 100 - 100 * Math.exp(-0.05));
        assert.ok(call.theta < 0 && call.gamma > 0 && call.vega > 0);
    });

    test("at expiration an option is worth its intrinsic value", () => {
        assert.equal(blackScholes({ type: "put", price: 9, strike: 10, years: 0, volatility: 0.3 }).price, 1);
    });

    test("a modeled quote keeps the close's mark until the stock moves, then moves with it, on the price increments", () => {
        const contract: ChainContract = {
            symbol: "F261120C00012000", underlying: "F", expiration: "2026-11-20", type: "call", strike: 12, date: "2026-10-27",
            last: 0.37, mark: 0.375, bid: 0.35, ask: 0.40, bidSize: 10, askSize: 10, volume: 100, openInterest: 1000, impliedVolatility: 0.41
        };
        const atClose = modelOptionQuote(contract, { underlying: 11.73, underlyingAtClose: 11.73, now: easternTime("2026-10-27", "16:00"), fallbackVolatility: 0.4 });
        near(atClose.price, 0.38, 0.006);
        assert.deepEqual([atClose.bid, atClose.ask], [0.35, 0.4], "the close's own quote");
        const up = modelOptionQuote(contract, { underlying: 12.23, underlyingAtClose: 11.73, now: easternTime("2026-10-28", "10:00"), fallbackVolatility: 0.4 });
        assert.ok(up.price > atClose.price + 0.15 && up.delta > 0.4, JSON.stringify(up));
        assert.ok(up.bid < up.ask);
        assert.equal(optionTick(2.99), 0.01);
        assert.equal(optionTick(3), 0.05);
        const deep = modelOptionQuote({ ...contract, strike: 5, symbol: "F261120C00005000", mark: 6.8, bid: 6.45, ask: 7.15, impliedVolatility: 0.01 },
            { underlying: 11, underlyingAtClose: 11.73, now: easternTime("2026-10-28", "10:00"), fallbackVolatility: 0.4 });
        assert.ok(deep.price >= 6 && Math.abs(deep.bid / 0.05 - Math.round(deep.bid / 0.05)) < 1e-9, JSON.stringify(deep));
        assert.equal(medianVolatility([{ impliedVolatility: 0.3 }, { impliedVolatility: 0.01 }, { impliedVolatility: 0.5 }]), 0.4);
    });
});

describe("The universal spread rule", () => {
    const option = (type: "call" | "put", strike: number, qty: number, expiration = "2026-11-20"): OptionHolding => ({ underlying: "F", expiration, type, strike, qty });

    test("a covered call needs nothing, a cash-secured put its strike, a long option nothing", () => {
        assert.equal(optionRequirement([option("call", 12, -1)], 100), 0);
        assert.equal(optionRequirement([option("put", 10, -2)]), 2000);
        assert.equal(optionRequirement([option("call", 12, 3)]), 0);
    });

    test("a spread needs its width, a naked call can't be covered", () => {
        assert.equal(optionRequirement([option("call", 10, -1), option("call", 15, 1)]), 500);
        assert.equal(optionRequirement([option("put", 10, -1), option("put", 5, 1)]), 500);
        assert.equal(optionRequirement([option("call", 10, 1), option("call", 15, -1)]), 0);
        // An iron condor: the wider side's width
        assert.equal(optionRequirement([option("put", 8, 1), option("put", 9, -1), option("call", 13, -1), option("call", 15, 1)]), 200);
        assert.equal(optionRequirement([option("call", 12, -1)]), Infinity);
        assert.equal(optionRequirement([option("call", 12, -2)], 100), Infinity);
    });

    test("a long call covers a short one that expires no later", () => {
        assert.equal(optionRequirement([option("call", 12, -1, "2026-11-20"), option("call", 12, 1, "2026-12-18")]), 0);
        assert.equal(optionRequirement([option("call", 12, 1, "2026-11-20"), option("call", 12, -1, "2026-12-18")]), Infinity);
    });

    test("shares covering calls can't be sold", () => {
        assert.equal(sharesCoveringCalls([option("call", 12, -2), option("call", 14, 1)]), 100);
        assert.equal(sharesCoveringCalls([option("put", 12, -2)]), 0);
    });
});

describe("Levels and orders", () => {
    const leg = (symbol: string, side: "buy" | "sell", opens = true, ratio = 1): OptionLeg & { opens: boolean } => ({ symbol, side, ratio, positionIntent: null, opens });
    const context = { holdings: [] as OptionHolding[], longShares: 0, mleg: false };

    test("buying is level 2, covered calls and cash-secured puts level 1, closing needs none", () => {
        assert.equal(requiredLevel([leg("F261120C00012000", "buy")], context), 2);
        assert.equal(requiredLevel([leg("F261120P00010000", "sell")], context), 1);
        assert.equal(requiredLevel([leg("F261120C00012000", "sell")], { ...context, longShares: 100 }), 1);
        assert.equal(requiredLevel([leg("F261120C00012000", "sell", false)], context), 0);
    });

    test("a short call covered by a long call is a spread (level 3); an uncovered one is refused", () => {
        const holdings = [{ underlying: "F", expiration: "2026-12-18", type: "call" as const, strike: 11, qty: 1 }];
        assert.equal(requiredLevel([leg("F261120C00012000", "sell")], { ...context, holdings }), 3);
        assert.throws(() => requiredLevel([leg("F261120C00012000", "sell")], context), /uncovered short calls/);
        assert.equal(requiredLevel([leg("F261120C00012000", "buy"), leg("F261120C00013000", "sell")], { ...context, mleg: true }), 3);
    });

    test("an mleg order's short legs must be covered within it", () => {
        assert.equal(mlegCoverageError([leg("F261120C00012000", "buy"), leg("F261120C00013000", "sell")]), null);
        assert.match(mlegCoverageError([leg("F261120C00012000", "sell"), leg("F261120C00013000", "sell")])!, /uncovered/);
        assert.equal(mlegCoverageError([leg("F261120P00009000", "buy"), leg("F261120P00010000", "sell"), leg("F261120C00013000", "sell"), leg("F261120C00015000", "buy")]), null);
        assert.equal(mlegCoverageError([leg("F261120C00012000", "sell"), leg("F261218C00012000", "buy")]), null);
        assert.match(mlegCoverageError([leg("F261218C00012000", "sell"), leg("F261120C00012000", "buy")])!, /uncovered/);
        // A roll closes one leg and opens another: only the opening short needs covering
        assert.match(mlegCoverageError([leg("F261120C00012000", "buy", false), leg("F261218C00012000", "sell")])!, /uncovered/);
    });

    test("orders follow Alpaca's option rules", () => {
        const now = easternTime("2026-10-28", "10:00");
        const base = { type: "limit" as const, timeInForce: "day" as const, qty: 1, notional: null, extendedHours: false, limitPrice: 0.35, stopPrice: null, legs: [leg("F261120C00012000", "buy")], mleg: false };
        assert.doesNotThrow(() => validateOptionOrder(base, now));
        assert.throws(() => validateOptionOrder({ ...base, qty: 1.5 }, now), /whole number/);
        assert.throws(() => validateOptionOrder({ ...base, timeInForce: "ioc" }, now), /day or gtc/);
        assert.throws(() => validateOptionOrder({ ...base, extendedHours: true }, now), /extended hours/);
        assert.throws(() => validateOptionOrder({ ...base, limitPrice: 3.02 }, now), /tick by \$0\.05/);
        assert.doesNotThrow(() => validateOptionOrder({ ...base, limitPrice: 3.05 }, now));
        assert.throws(() => validateOptionOrder({ ...base, legs: [leg("F261028C00012000", "buy")] }, easternTime("2026-10-28", "15:20")), /3:15 p.m./);
        assert.throws(() => validateOptionOrder({ ...base, legs: [leg("F261027C00012000", "buy")] }, now), /expired/);
        const mleg = { ...base, mleg: true, limitPrice: -0.37 };
        assert.doesNotThrow(() => validateOptionOrder({ ...mleg, legs: [leg("F261120C00012000", "buy"), leg("F261120C00013000", "sell", true, 2)] }, now));
        assert.throws(() => validateOptionOrder({ ...mleg, legs: [leg("F261120C00012000", "buy", true, 2), leg("F261120C00013000", "sell", true, 4)] }, now), /greatest common divisor/);
        assert.throws(() => validateOptionOrder({ ...mleg, type: "stop" as const, stopPrice: 1 }, now), /mleg orders must be market or limit/);
        assert.throws(() => validateOptionOrder({ ...mleg, legs: [leg("F261120C00012000", "buy"), leg("GM261120C00013000", "sell")] }, now), /one underlying/);
    });

    test("an mleg order's net price: buys at the ask less sells at the bid", () => {
        assert.equal(mlegNetPrice([{ side: "buy", ratio: 1 }, { side: "sell", ratio: 1 }], [{ bid: 0.35, ask: 0.40 }, { bid: 0.10, ask: 0.12 }]), 0.3);
        assert.equal(mlegNetPrice([{ side: "sell", ratio: 2 }, { side: "buy", ratio: 1 }], [{ bid: 0.35, ask: 0.40 }, { bid: 0.10, ask: 0.12 }]), -0.58);
    });
});

describe("Expiration, exercise and assignment", () => {
    test("in the money by a cent or more: longs are exercised, shorts assigned", () => {
        assert.equal(expirationOutcome({ type: "call", strike: 12, qty: 1 }, 12.01), "exercise");
        assert.equal(expirationOutcome({ type: "call", strike: 12, qty: 1 }, 12.005), "expire");
        assert.equal(expirationOutcome({ type: "put", strike: 12, qty: -1 }, 11.5), "assign");
        assert.equal(expirationOutcome({ type: "call", strike: 12, qty: 1 }, 13, { doNotExercise: true }), "expire");
    });

    test("an exercise trades shares at the strike, with the premium in the lots' price", () => {
        assert.deepEqual(deliveryFor({ type: "call", strike: 12, qty: 2, premium: 0.4 }), { side: "buy", shares: 200, cashPrice: 12, lotPrice: 12.4 });
        assert.deepEqual(deliveryFor({ type: "put", strike: 12, qty: 1, premium: 0.4 }), { side: "sell", shares: 100, cashPrice: 12, lotPrice: 11.6 });
        assert.deepEqual(deliveryFor({ type: "call", strike: 12, qty: -1, premium: 0.4 }), { side: "sell", shares: 100, cashPrice: 12, lotPrice: 12.4 });
        assert.deepEqual(deliveryFor({ type: "put", strike: 12, qty: -1, premium: 0.4 }), { side: "buy", shares: 100, cashPrice: 12, lotPrice: 11.6 });
    });

    test("a short call is assigned early before an ex-date when its time value is below the dividend", () => {
        assert.equal(earlyAssignmentLikely({ type: "call", strike: 10, underlying: 12, optionPrice: 2.05, dividend: 0.15 }), true);
        assert.equal(earlyAssignmentLikely({ type: "call", strike: 10, underlying: 12, optionPrice: 2.3, dividend: 0.15 }), false);
        assert.equal(earlyAssignmentLikely({ type: "put", strike: 14, underlying: 12, optionPrice: 2, dividend: 0.15 }), false);
    });
});
