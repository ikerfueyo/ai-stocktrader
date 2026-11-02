// What an open order does on one matching tick, given the current quote and session: activate, track a trailing stop's high-water
// mark, trigger a stop, fill (all of it or what the liquidity allows), expire or cancel. And how much buying power open orders hold
// back. Pure, so it can be unit tested; ./orders.ts runs it on stored orders and applies the result.
import { fillPrice, roundCents, roundPrice } from "../../account";
import type { FillPolicy, Quote } from "../../../types";
import type { OrderSide, OrderType, TimeInForce } from "../types";

export type Session = "pre-market" | "regular" | "after-hours" | "closed";

// An open order as matched (sim_orders' NUMERIC columns parsed)
export interface LiveOrder {
    id: string;
    side: OrderSide;
    type: OrderType;
    timeInForce: TimeInForce;
    status: string;
    qty: number | null;
    notional: number | null;
    filledQty: number;
    // What the fills so far paid or received, for a notional order's remainder
    filledNotional: number;
    limitPrice: number | null;
    stopPrice: number | null;
    trailPrice: number | null;
    trailPercent: number | null;
    hwm: number | null;
    extendedHours: boolean;
    triggered: boolean;
    expiresAt: Date;
}

export type MatchQuote = Pick<Quote, "price" | "bid" | "ask" | "spread" | "open" | "volume">;

export interface MatchContext {
    now: Date;
    session: Session;
    // Today's regular session, if today is a trading day
    regularOpen: Date | null;
    regularClose: Date | null;
    // The share of the average shares traded per minute so far today that one tick can fill (SIM_LIQUIDITY_SHARE)
    liquidityShare: number;
}

export interface MatchFill {
    // Shares, for a qty order; dollars, for a notional order (its shares are worked out at the fill price)
    qty: number | null;
    notional: number | null;
    price: number;
    fillPolicy: FillPolicy;
}

export interface MatchResult {
    // An order accepted outside its session goes live (new) once its session opens
    activate?: boolean;
    // A trailing stop's new high-water mark (the highest price for a sell, the lowest for a buy) and the stop price it gives
    hwm?: number;
    stopPrice?: number;
    // A stop or trailing stop reached its stop price
    triggered?: boolean;
    fill?: MatchFill;
    // The order stops working (after any fill): expired at its time, or cancelled (an IOC or FOK remainder, an auction it missed)
    end?: { status: "expired" | "canceled"; reason: string };
}

// The fewest shares a tick fills when liquidity is low, a round lot
const MIN_TICK_SHARES = 100;

const remainingQty = (order: LiveOrder) => order.qty === null ? null : Math.max(0, order.qty - order.filledQty);

// Whether the order can trade in this session: regular-hours orders in the regular session, extended-hours limit orders in the
// pre-market and after-hours sessions too
export const tradesIn = (order: Pick<LiveOrder, "extendedHours" | "timeInForce">, session: Session) =>
    session === "regular" ? order.timeInForce !== "cls" : session !== "closed" && order.extendedHours;

// The trailing stop's stop price for a high-water mark: below it for a sell, above it for a buy
export const trailingStop = (order: Pick<LiveOrder, "side" | "trailPrice" | "trailPercent">, hwm: number): number => {
    const offset = order.trailPrice ?? hwm * (order.trailPercent! / 100);
    return roundPrice(order.side === "sell" ? hwm - offset : hwm + offset);
};

// Whether the last price has reached a stop: a buy stop at or above it, a sell stop at or below it
export const stopReached = (side: OrderSide, stopPrice: number, price: number) => side === "buy" ? price >= stopPrice : price <= stopPrice;

// The most shares one tick fills: a share of the average shares traded per minute so far today, at least a round lot. Unlimited
// without volume data.
export const liquidityCap = (quote: MatchQuote, context: Pick<MatchContext, "now" | "regularOpen" | "liquidityShare">): number => {
    if (!quote.volume || !(context.liquidityShare > 0)) return Infinity;
    const minutes = context.regularOpen ? Math.min(390, Math.max(1, (context.now.getTime() - context.regularOpen.getTime()) / 60000)) : 390;
    return Math.max(MIN_TICK_SHARES, Math.floor(context.liquidityShare * quote.volume / minutes));
};

const marketableAt = (side: OrderSide, limitPrice: number, price: number) => side === "buy" ? price <= limitPrice + 1e-9 : price >= limitPrice - 1e-9;

// The order's fill on this tick, at the quote (asks for buys, bids for sells), for its remaining size, capped by the liquidity for
// whole-share orders (fractional and notional orders fill in full, as Alpaca fills them itself)
const sizeFill = (order: LiveOrder, price: number, fillPolicy: FillPolicy, cap: number): MatchFill | null => {
    if (order.notional !== null) {
        const left = roundCents(order.notional - order.filledNotional);
        return left >= 0.01 ? { qty: null, notional: left, price, fillPolicy } : null;
    }
    const left = remainingQty(order)!;
    if (!(left > 0)) return null;
    const whole = Math.abs(order.qty! - Math.round(order.qty!)) < 1e-9;
    return { qty: whole ? Math.min(left, Math.max(1, Math.floor(cap))) : left, notional: null, price, fillPolicy };
};

// What the order does now. Nothing happens without a quote except activation and expiry.
//   market (and a triggered stop or trailing stop): fills at the ask (buy) or bid (sell).
//   limit (and a triggered stop_limit): fills when marketable, at the quote, which is never worse than the limit.
//   stop and stop_limit trigger when the last price reaches the stop; trailing stops follow the price with their high-water mark and
//   trigger when it falls back by the trail. Stops trigger in the regular session only.
//   opg: fills in the opening auction (the session's open price), or is cancelled; cls: in the closing auction (the close).
//   ioc: fills what it can now and cancels the rest; fok: fills all of it now or is cancelled.
export const evaluateOrder = (order: LiveOrder, quote: MatchQuote | null, context: MatchContext): MatchResult => {
    const { now, session } = context;
    const result: MatchResult = {};
    const { side } = order;

    // Auctions: OPG at the first tick of the regular session, CLS at the first tick after the close, on the auction price
    if (order.timeInForce === "opg" || order.timeInForce === "cls") {
        const auctionAt = order.timeInForce === "opg" ? context.regularOpen : context.regularClose;
        const auctionDue = auctionAt !== null && now >= auctionAt && (order.timeInForce === "cls" || session === "regular");
        if (!auctionDue) {
            if (now >= order.expiresAt && order.timeInForce === "cls") return { end: { status: "expired", reason: "The closing auction passed without the order" } };
            return {};
        }
        if (!quote) return {};
        const price = order.timeInForce === "opg" ? quote.open ?? quote.price : quote.price;
        const policy: FillPolicy = order.timeInForce === "opg" ? "OPEN" : "CLOSE";
        if (order.type === "limit" && !marketableAt(side, order.limitPrice!, price)) {
            return { end: { status: "canceled", reason: `Not filled in the ${order.timeInForce === "opg" ? "opening" : "closing"} auction at ${price}` } };
        }
        const fill = sizeFill(order, roundPrice(price), policy, Infinity);
        return fill ? { fill } : {};
    }

    if (now >= order.expiresAt) {
        return { end: { status: "expired", reason: order.timeInForce === "gtc" ? "GTC order expired after 90 days" : "Day order expired at the close" } };
    }
    if (!tradesIn(order, session)) return result;
    if (order.status === "accepted") result.activate = true;
    if (!quote) return result;

    let triggered = order.triggered;
    if (order.type === "trailing_stop") {
        if (session !== "regular") return result;
        const previous = order.hwm ?? quote.price;
        const hwm = side === "sell" ? Math.max(previous, quote.price) : Math.min(previous, quote.price);
        const stopPrice = trailingStop(order, hwm);
        if (hwm !== order.hwm || stopPrice !== order.stopPrice) {
            result.hwm = hwm;
            result.stopPrice = stopPrice;
        }
        if (!triggered && stopReached(side, stopPrice, quote.price)) triggered = result.triggered = true;
        if (!triggered) return result;
    } else if ((order.type === "stop" || order.type === "stop_limit") && !triggered) {
        if (session !== "regular" || !stopReached(side, order.stopPrice!, quote.price)) return result;
        triggered = result.triggered = true;
    }

    const { price, fillPolicy } = fillPrice(side === "buy" ? "BUY" : "SELL", quote);
    const limited = order.type === "limit" || order.type === "stop_limit";
    const marketable = !limited || marketableAt(side, order.limitPrice!, price);
    const immediate = order.timeInForce === "ioc" || order.timeInForce === "fok";
    if (!marketable) {
        return immediate ? { ...result, end: { status: "canceled", reason: `${order.timeInForce.toUpperCase()} order wasn't marketable` } } : result;
    }
    const cap = liquidityCap(quote, context);
    const fill = sizeFill(order, price, fillPolicy, cap);
    if (!fill) return result;
    if (order.timeInForce === "fok" && fill.qty !== null && fill.qty < remainingQty(order)! - 1e-9) {
        return { ...result, end: { status: "canceled", reason: "FOK order couldn't fill in full" } };
    }
    result.fill = fill;
    if (order.timeInForce === "ioc" && fill.qty !== null && fill.qty < remainingQty(order)! - 1e-9) {
        result.end = { status: "canceled", reason: "IOC order's unfilled remainder was cancelled" };
    }
    return result;
};

// The price an opening order is checked and reserved at, as Alpaca checks buying power: a buy at its limit (or stop) or else the
// ask; a short sale at the higher of its limit and 3% above the ask (a market short could fill well above the last price)
export const reservationPrice = (order: Pick<LiveOrder, "side" | "limitPrice" | "stopPrice">, quote: Pick<Quote, "price" | "ask" | "bid"> | null): number | null => {
    const ask = quote ? quote.ask ?? quote.price : null;
    if (order.side === "buy") return order.limitPrice ?? order.stopPrice ?? ask;
    const buffered = ask === null ? null : roundPrice(ask * 1.03);
    if (order.limitPrice !== null) return buffered === null ? order.limitPrice : Math.max(order.limitPrice, buffered);
    return order.stopPrice ?? buffered;
};

// What open orders that open or add to a position hold back from buying power: a buy its remaining cost, a short sale its remaining
// value (both at their reservation price), a non-marginable stock's on margin that × the multiplier (it needs 100% initial margin).
// Orders that close the position (an order can't go through zero) and legs waiting for their entry hold nothing.
export const reservedForOrders = (
    orders: (Pick<LiveOrder, "side" | "limitPrice" | "stopPrice" | "qty" | "notional" | "filledQty" | "filledNotional"> & { symbol: string; held?: boolean })[],
    positions: Record<string, number>,
    quotes: Record<string, Pick<Quote, "price" | "ask" | "bid"> | undefined>,
    { marginable = {}, multiplier = 1 }: { marginable?: Record<string, boolean | null>; multiplier?: number } = {}
): number => {
    let reserved = 0;
    for (const order of orders) {
        const held = positions[order.symbol] ?? 0;
        if (order.held || (order.side === "sell" ? held > 0 : held < 0)) continue;
        const price = reservationPrice(order, quotes[order.symbol] ?? null);
        const value = order.notional !== null ? order.notional - order.filledNotional : price === null ? null : (order.qty! - order.filledQty) * price;
        if (value === null || !(value > 0)) continue;
        reserved += marginable[order.symbol] === false && multiplier > 1 ? value * multiplier : value;
    }
    return roundCents(reserved);
};
