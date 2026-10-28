import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyReplace, orderExpiry, parseOrderRequest, validateOrder, type OrderContext, type OpenOrderSummary } from "./orderRules";
import { evaluateOrder, liquidityCap, reservedForOrders, trailingStop, type LiveOrder, type MatchContext, type MatchQuote } from "./matching";
import { BrokerError } from "../errors";
import type { CreateOrderRequest } from "../types";

// Wednesday, Oct 28, 2026 (EDT, UTC-4): the regular session is 13:30Z to 20:00Z
const at = (time: string, day = "2026-10-28") => new Date(`${day}T${time}-04:00`);
const OPEN = at("09:30:00");
const CLOSE = at("16:00:00");

const context = (overrides: Partial<OrderContext> = {}): OrderContext => ({
    now: at("10:00:00"), asset: { tradable: true, fractionable: true, shortable: true, attributes: [] }, price: 100, position: 0,
    openOrders: [], configurations: { fractional_trading: true, no_shorting: false }, ...overrides
});

const request = (overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest =>
    ({ symbol: "AAA", side: "buy", type: "market", time_in_force: "day", qty: "10", ...overrides }) as CreateOrderRequest;

const check = (overrides: Partial<CreateOrderRequest>, ctx: Partial<OrderContext> = {}) => validateOrder(parseOrderRequest(request(overrides)), context(ctx));

const rejects = (fn: () => void, status: number, pattern: RegExp) => assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrokerError, `expected a BrokerError, got ${error}`);
    assert.equal(error.status, status, error.message);
    assert.match(error.message, pattern);
    return true;
});

const openOrder = (overrides: Partial<OpenOrderSummary>): OpenOrderSummary =>
    ({ id: "o1", side: "sell", type: "limit", limitPrice: 105, remainingQty: 5, notionalLeft: null, groupId: null, held: false, ...overrides });

describe("order validation", () => {
    test("accepts the common orders", () => {
        check({});
        check({ type: "limit", limit_price: "99.5", time_in_force: "gtc" });
        check({ type: "stop_limit", stop_price: "101", limit_price: "102" });
        check({ type: "trailing_stop", trail_percent: "5", time_in_force: "gtc" });
        check({ qty: undefined, notional: "25.50" });
        check({ qty: "0.5" });
    });

    test("qty and notional: exactly one, a notional of at least $1 in cents, up to 9 decimals of shares", () => {
        rejects(() => check({ qty: undefined }), 422, /qty or notional is required/);
        rejects(() => check({ notional: "10" }), 422, /only one of qty or notional/);
        rejects(() => check({ qty: undefined, notional: "0.99" }), 422, /at least \$1/);
        rejects(() => check({ qty: "0.0000000001" }), 422, /9 decimal places/);
        rejects(() => check({ qty: "-1" }), 422, /positive/);
    });

    test("prices follow the tick size: cents at $1 and above, 4 decimals below", () => {
        rejects(() => check({ type: "limit", limit_price: "10.005" }), 422, /sub-penny increment/);
        check({ type: "limit", limit_price: "0.5005" });
        rejects(() => check({ type: "limit", limit_price: "0.50005" }), 422, /sub-penny increment/);
        rejects(() => check({ type: "limit" }), 422, /limit_price is required/);
        rejects(() => check({ type: "stop" }), 422, /stop_price is required/);
    });

    test("fractional and notional orders are day orders, never short, on fractionable assets", () => {
        rejects(() => check({ qty: "1.5", time_in_force: "gtc" }), 422, /must be day orders/);
        rejects(() => check({ qty: "1.5", side: "sell" }), 403, /can't be sold short/);
        rejects(() => check({ qty: "1.5" }, { asset: { tradable: true, fractionable: false, shortable: true, attributes: [] } }), 422, /not fractionable/);
        rejects(() => check({ qty: undefined, notional: "50", type: "stop", stop_price: "101" }), 422, /notional orders must be market or limit/);
        rejects(() => check({ qty: "1.5" }, { configurations: { fractional_trading: false } }), 403, /fractional trading is disabled/);
        check({ qty: "1.5", side: "sell" }, { position: 3 });
    });

    test("extended hours are for day or GTC limit orders only", () => {
        check({ type: "limit", limit_price: "100", extended_hours: true });
        rejects(() => check({ extended_hours: true }), 422, /extended hours orders must be day or gtc limit/);
        rejects(() => check({ type: "limit", limit_price: "100", time_in_force: "ioc", extended_hours: true }), 422, /extended hours/);
    });

    test("OPG and CLS have submission windows and take market or limit orders", () => {
        rejects(() => check({ time_in_force: "opg" }), 422, /opg orders can't be submitted/);
        check({ time_in_force: "opg" }, { now: at("09:00:00") });
        check({ time_in_force: "opg" }, { now: at("19:30:00") });
        check({ time_in_force: "cls" }, { now: at("15:45:00") });
        rejects(() => check({ time_in_force: "cls" }, { now: at("15:51:00") }), 422, /cls orders can't be submitted/);
        rejects(() => check({ type: "stop", stop_price: "101", time_in_force: "ioc" }), 422, /ioc orders must be market or limit/);
    });

    test("bracket legs sit at least a cent beyond the base price", () => {
        const bracket = { order_class: "bracket" as const, type: "limit" as const, limit_price: "100", take_profit: { limit_price: "110" }, stop_loss: { stop_price: "95" } };
        check(bracket);
        rejects(() => check({ ...bracket, take_profit: { limit_price: "100" } }), 422, /take_profit.limit_price must be >= base_price \+ 0.01/);
        rejects(() => check({ ...bracket, stop_loss: { stop_price: "100" } }), 422, /stop_loss.stop_price must be <= base_price - 0.01/);
        rejects(() => check({ ...bracket, stop_loss: undefined }), 422, /need take_profit and stop_loss/);
        rejects(() => check({ ...bracket, qty: "1.5" }), 422, /fractional/);
        // A sell bracket mirrors it, judged against the current price for a market entry
        check({ order_class: "bracket", side: "sell", take_profit: { limit_price: "90" }, stop_loss: { stop_price: "105" } });
        check({ order_class: "oto", stop_loss: { stop_price: "95" } });
        rejects(() => check({ order_class: "oto", take_profit: { limit_price: "110" }, stop_loss: { stop_price: "95" } }), 422, /exactly one/);
    });

    test("OCO orders exit a position with a take profit above the stop loss", () => {
        const oco = { order_class: "oco" as const, side: "sell" as const, type: "limit" as const, time_in_force: "gtc" as const, take_profit: { limit_price: "110" }, stop_loss: { stop_price: "95" } };
        check(oco, { position: 10 });
        rejects(() => check(oco, { position: 0 }), 403, /must close an open position/);
        rejects(() => check({ ...oco, take_profit: { limit_price: "94" } }, { position: 10 }), 422, /above stop_loss/);
    });

    test("an order can't go through zero or sell shares other orders hold", () => {
        rejects(() => check({ side: "sell", qty: "15" }, { position: 10 }), 403, /insufficient qty available for order \(requested: 15, available: 10\)/);
        rejects(() => check({ side: "sell", qty: "6", type: "stop", stop_price: "90" }, { position: 10, openOrders: [openOrder({ remainingQty: 5 })] }), 403, /available: 5/);
        rejects(() => check({ qty: "11" }, { position: -10 }), 403, /insufficient qty/);
        check({ side: "sell", qty: "10" }, { position: 10 });
        // A close is capped when it fills, so it only needs shares available
        check({ side: "sell", qty: "15", position_intent: "sell_to_close" }, { position: 10 });
        rejects(() => check({ side: "sell", position_intent: "sell_to_close" }, { position: 0 }), 403, /insufficient qty/);
        rejects(() => check({ side: "sell", position_intent: "buy_to_close" }, { position: 5 }), 422, /doesn't match side/);
    });

    test("shorting needs an account and an asset that allow it", () => {
        rejects(() => check({ side: "sell" }, { configurations: { no_shorting: true } }), 403, /not allowed to short/);
        rejects(() => check({ side: "sell" }, { asset: { tradable: true, fractionable: true, shortable: false, attributes: [] } }), 403, /cannot be sold short/);
        rejects(() => check({}, { asset: { tradable: false, fractionable: true, shortable: true, attributes: [] } }), 422, /not tradable/);
    });

    test("an order that could fill against the account's own opposite order is a potential wash trade", () => {
        const resting = [openOrder({ side: "sell", type: "limit", limitPrice: 105 })];
        rejects(() => check({}, { position: 10, openOrders: resting }), 403, /potential wash trade/);
        rejects(() => check({ type: "limit", limit_price: "105" }, { position: 10, openOrders: resting }), 403, /wash trade/);
        check({ type: "limit", limit_price: "104.99" }, { position: 10, openOrders: resting });
        check({}, { position: 10, openOrders: [openOrder({ type: "stop", limitPrice: null })] });
        check({}, { position: 10, openOrders: [openOrder({ held: true })] });
    });

    test("orders expire at their session's close, extended ones after hours, GTC after 90 days", () => {
        const day = { timeInForce: "day" as const, extendedHours: false };
        assert.equal(orderExpiry(day, at("10:00:00")).toISOString(), CLOSE.toISOString());
        assert.equal(orderExpiry(day, at("08:00:00")).toISOString(), CLOSE.toISOString());
        assert.equal(orderExpiry(day, at("17:00:00")).toISOString(), at("16:00:00", "2026-10-29").toISOString());
        assert.equal(orderExpiry({ timeInForce: "day", extendedHours: true }, at("17:00:00")).toISOString(), at("20:00:00").toISOString());
        // Friday after the close: Monday's close
        assert.equal(orderExpiry(day, at("18:00:00", "2026-10-30")).toISOString(), new Date("2026-11-02T16:00:00-05:00").toISOString());
        assert.equal(orderExpiry({ timeInForce: "opg", extendedHours: false }, at("19:30:00")).toISOString(), at("09:30:00", "2026-10-29").toISOString());
        assert.equal(orderExpiry({ timeInForce: "gtc", extendedHours: false }, at("10:00:00")).toISOString(), new Date("2027-01-26T16:00:00-05:00").toISOString());
    });

    test("a replace keeps what it doesn't change and refuses notional and fractional quantity changes", () => {
        const limit = parseOrderRequest(request({ type: "limit", limit_price: "100" }));
        const replaced = applyReplace(limit, { limit_price: "101", qty: "12" }, 0);
        assert.equal(replaced.limitPrice, 101);
        assert.equal(replaced.qty, 12);
        assert.equal(replaced.type, "limit");
        rejects(() => applyReplace(parseOrderRequest(request({ qty: undefined, notional: "50" })), { qty: "1" }, 0), 422, /notional orders can't be replaced/);
        rejects(() => applyReplace(parseOrderRequest(request({ qty: "1.5" })), { qty: "2" }, 0), 422, /fractional/);
        rejects(() => applyReplace(limit, { qty: "2.5" }, 0), 422, /whole shares/);
        rejects(() => applyReplace(limit, { stop_price: "90" }, 0), 422, /stop_price can only be replaced/);
        rejects(() => applyReplace(limit, {}, 0), 422, /nothing to replace/);
    });
});

const live = (overrides: Partial<LiveOrder> = {}): LiveOrder => ({
    id: "o1", side: "buy", type: "market", timeInForce: "day", status: "new", qty: 10, notional: null, filledQty: 0, filledNotional: 0,
    limitPrice: null, stopPrice: null, trailPrice: null, trailPercent: null, hwm: null, extendedHours: false, triggered: false, expiresAt: CLOSE, ...overrides
});

const quote = (overrides: Partial<MatchQuote> = {}): MatchQuote => ({ price: 100, bid: 99.9, ask: 100.1, spread: "quoted", open: 98, volume: null, ...overrides });

const match = (overrides: Partial<MatchContext> = {}): MatchContext =>
    ({ now: at("10:00:00"), session: "regular", regularOpen: OPEN, regularClose: CLOSE, liquidityShare: 0.1, ...overrides });

describe("order matching", () => {
    test("market orders fill at the ask or bid during the regular session", () => {
        assert.deepEqual(evaluateOrder(live(), quote(), match()).fill, { qty: 10, notional: null, price: 100.1, fillPolicy: "ASK" });
        assert.equal(evaluateOrder(live({ side: "sell" }), quote(), match()).fill?.price, 99.9);
        assert.deepEqual(evaluateOrder(live(), quote(), match({ session: "after-hours" })), {});
    });

    test("an order accepted outside its session goes live when it opens", () => {
        const result = evaluateOrder(live({ status: "accepted" }), null, match());
        assert.equal(result.activate, true);
        assert.equal(result.fill, undefined);
    });

    test("limit orders fill only when marketable, at the quote", () => {
        assert.equal(evaluateOrder(live({ type: "limit", limitPrice: 100 }), quote(), match()).fill, undefined);
        assert.equal(evaluateOrder(live({ type: "limit", limitPrice: 100.1 }), quote(), match()).fill?.price, 100.1);
        assert.equal(evaluateOrder(live({ type: "limit", side: "sell", limitPrice: 99.5 }), quote(), match()).fill?.price, 99.9);
    });

    test("extended-hours limit orders trade before the open and after the close", () => {
        const order = live({ type: "limit", limitPrice: 101, extendedHours: true, expiresAt: at("20:00:00") });
        assert.equal(evaluateOrder(order, quote(), match({ session: "pre-market", now: at("08:00:00") })).fill?.price, 100.1);
        assert.equal(evaluateOrder(order, quote(), match({ session: "after-hours", now: at("17:00:00") })).fill?.price, 100.1);
        assert.equal(evaluateOrder(order, quote(), match({ session: "closed", now: at("21:00:00") })).end?.status, "expired");
    });

    test("stops trigger on the last price in the regular session, then fill as market or limit orders", () => {
        const stop = live({ side: "sell", type: "stop", stopPrice: 95 });
        assert.deepEqual(evaluateOrder(stop, quote(), match()), {});
        const triggered = evaluateOrder(stop, quote({ price: 94.9, bid: 94.8, ask: 95 }), match());
        assert.equal(triggered.triggered, true);
        assert.equal(triggered.fill?.price, 94.8);
        assert.deepEqual(evaluateOrder(stop, quote({ price: 94 }), match({ session: "pre-market" })), {});
        const stopLimit = live({ side: "sell", type: "stop_limit", stopPrice: 95, limitPrice: 94.9 });
        const gapped = evaluateOrder(stopLimit, quote({ price: 94, bid: 93.9, ask: 94.1 }), match());
        assert.equal(gapped.triggered, true);
        assert.equal(gapped.fill, undefined);
        assert.equal(evaluateOrder({ ...stopLimit, triggered: true }, quote({ price: 95, bid: 94.95, ask: 95.05 }), match()).fill?.price, 94.95);
    });

    test("trailing stops follow the high-water mark and trigger when the price falls back by the trail", () => {
        const order = live({ side: "sell", type: "trailing_stop", trailPercent: 5, hwm: 100, stopPrice: 95 });
        const higher = evaluateOrder(order, quote({ price: 110 }), match());
        assert.equal(higher.hwm, 110);
        assert.equal(higher.stopPrice, 104.5);
        assert.equal(higher.fill, undefined);
        const fallen = evaluateOrder({ ...order, hwm: 110, stopPrice: 104.5 }, quote({ price: 104.4, bid: 104.3, ask: 104.5 }), match());
        assert.equal(fallen.triggered, true);
        assert.equal(fallen.fill?.price, 104.3);
        assert.equal(trailingStop({ side: "buy", trailPrice: 2, trailPercent: null }, 50), 52);
    });

    test("big whole-share orders fill in parts, by a share of the volume traded per minute", () => {
        // 39,000 shares in the first 390 minutes: 100 a minute, so a 10% share is 10, raised to a round lot
        assert.equal(liquidityCap(quote({ volume: 39000 }), match({ now: CLOSE })), 100);
        assert.equal(liquidityCap(quote({ volume: 3_900_000 }), match({ now: CLOSE })), 1000);
        const big = live({ qty: 5000, expiresAt: at("20:00:00") });
        assert.equal(evaluateOrder(big, quote({ volume: 3_900_000 }), match({ now: CLOSE })).fill?.qty, 1000);
        assert.equal(evaluateOrder({ ...big, filledQty: 4500 }, quote({ volume: 3_900_000 }), match({ now: CLOSE })).fill?.qty, 500);
        // Fractional and notional orders fill in full
        assert.equal(evaluateOrder(live({ qty: 2.5 }), quote({ volume: 100 }), match()).fill?.qty, 2.5);
        assert.deepEqual(evaluateOrder(live({ qty: null, notional: 50, filledNotional: 0 }), quote(), match()).fill, { qty: null, notional: 50, price: 100.1, fillPolicy: "ASK" });
    });

    test("IOC fills what it can and cancels the rest; FOK fills all or nothing", () => {
        const thin = quote({ volume: 39000 });
        const ioc = evaluateOrder(live({ qty: 500, timeInForce: "ioc", expiresAt: at("20:00:00") }), thin, match({ now: CLOSE }));
        assert.equal(ioc.fill?.qty, 100);
        assert.equal(ioc.end?.status, "canceled");
        const fok = evaluateOrder(live({ qty: 500, timeInForce: "fok", expiresAt: at("20:00:00") }), thin, match({ now: CLOSE }));
        assert.equal(fok.fill, undefined);
        assert.match(fok.end!.reason, /FOK/);
        assert.equal(evaluateOrder(live({ timeInForce: "ioc", type: "limit", limitPrice: 99 }), quote(), match()).end?.status, "canceled");
    });

    test("OPG fills in the opening auction and CLS in the closing one", () => {
        const opg = live({ timeInForce: "opg", status: "accepted", expiresAt: OPEN });
        assert.deepEqual(evaluateOrder(opg, quote(), match({ session: "pre-market", now: at("09:00:00") })), {});
        assert.deepEqual(evaluateOrder(opg, quote(), match({ now: at("09:30:10") })).fill, { qty: 10, notional: null, price: 98, fillPolicy: "OPEN" });
        assert.equal(evaluateOrder({ ...opg, type: "limit", limitPrice: 97 }, quote(), match({ now: at("09:30:10") })).end?.status, "canceled");
        const cls = live({ timeInForce: "cls", side: "sell" });
        assert.deepEqual(evaluateOrder(cls, quote(), match({ now: at("15:00:00") })), {});
        assert.equal(evaluateOrder(cls, quote({ price: 101 }), match({ session: "after-hours", now: at("16:00:30") })).fill?.price, 101);
    });

    test("day orders expire at their close, whatever the session", () => {
        assert.deepEqual(evaluateOrder(live({ type: "limit", limitPrice: 90 }), quote(), match({ session: "after-hours", now: CLOSE })).end, { status: "expired", reason: "Day order expired at the close" });
    });
});

describe("buying power held for open orders", () => {
    const order = (overrides: object) => ({ symbol: "AAA", side: "buy" as const, limitPrice: null, stopPrice: null, qty: 10, notional: null, filledQty: 0, filledNotional: 0, ...overrides });

    test("buys hold their remaining cost at the limit, else the ask", () => {
        assert.equal(reservedForOrders([order({ limitPrice: 50 })], {}, {}), 500);
        assert.equal(reservedForOrders([order({ filledQty: 4 })], {}, { AAA: { price: 100, ask: 100.5, bid: 99.5 } }), 603);
        assert.equal(reservedForOrders([order({ qty: null, notional: 250, filledNotional: 50 })], {}, {}), 200);
    });

    test("shorts hold half their value at the higher of the limit and 3% above the ask", () => {
        assert.equal(reservedForOrders([order({ side: "sell" })], {}, { AAA: { price: 100, ask: 100, bid: 99.9 } }), 515);
        assert.equal(reservedForOrders([order({ side: "sell", limitPrice: 110 })], {}, { AAA: { price: 100, ask: 100, bid: 99.9 } }), 550);
    });

    test("closing orders and held legs hold nothing", () => {
        assert.equal(reservedForOrders([order({ side: "sell", limitPrice: 120 })], { AAA: 10 }, {}), 0);
        assert.equal(reservedForOrders([order({ limitPrice: 50, held: true })], {}, {}), 0);
    });
});
