// Order matching: when an open order fills, triggers or expires, and how much cash open orders hold back. Pure functions, so they
// can be unit tested without a database; lib/server/orders.ts runs them against stored orders and current quotes.
import { fillPrice, reducesPosition, roundCents } from "./account";
import type { FillPolicy, OrderRow, OrderType, Position, Quote, TimeInForce, TradeType } from "../types";

// An open order as matched: an orders row with its NUMERIC columns parsed
export interface OpenOrder {
    id: number;
    ticker: string;
    side: TradeType;
    orderType: OrderType;
    quantity: number | null;
    amount: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
    timeInForce: TimeInForce;
    expiresAt: Date | null;
    triggeredAt: Date | null;
    closeOnly: boolean;
}

export const toOpenOrder = (row: OrderRow): OpenOrder => ({
    id: row.id,
    ticker: row.ticker.toUpperCase(),
    side: row.side,
    orderType: row.order_type,
    quantity: row.quantity === null ? null : parseFloat(row.quantity),
    amount: row.amount === null ? null : parseFloat(row.amount),
    limitPrice: row.limit_price === null ? null : parseFloat(row.limit_price),
    stopPrice: row.stop_price === null ? null : parseFloat(row.stop_price),
    timeInForce: row.time_in_force,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    triggeredAt: row.triggered_at === null ? null : new Date(row.triggered_at),
    closeOnly: row.close_only === true
});

export type Evaluation =
    | { action: "fill"; price: number; fillPolicy: FillPolicy; triggered: boolean }
    | { action: "trigger" }
    | { action: "expire"; reason: string }
    | { action: "none" };

type FillQuote = Pick<Quote, "price" | "bid" | "ask" | "spread">;

// Whether a stop price has been reached: a buy stop at or above it, a sell stop at or below it (judged on the last price)
export const stopReached = (side: TradeType, stopPrice: number, price: number): boolean => side === "BUY" ? price >= stopPrice : price <= stopPrice;

// The limit fill, if the quote is marketable: a buy limit fills at the ask when the ask is at or below the limit, a sell limit at
// the bid when the bid is at or above it
const limitFill = (side: TradeType, limitPrice: number, quote: FillQuote) => {
    const fill = fillPrice(side, quote);
    return (side === "BUY" ? fill.price <= limitPrice : fill.price >= limitPrice) ? fill : null;
};

// What to do with an open order now. DAY orders expire at their session's close, whether or not the market is open; otherwise
// nothing happens while the market is closed or without a current quote.
//   MARKET (queued while the market was closed): fills at the ask (buy) or bid (sell).
//   LIMIT: fills when marketable (limitFill), at the quote, which is never worse than the limit.
//   STOP: once the last price reaches the stop, fills like a market order.
//   STOP_LIMIT: once the last price reaches the stop, it's a limit order. The trigger is kept (triggeredAt) even if the price
//   moves back.
export const evaluateOrder = (order: OpenOrder, quote: FillQuote | null, { now, marketOpen }: { now: Date; marketOpen: boolean }): Evaluation => {
    if (order.expiresAt && now >= order.expiresAt) {
        return { action: "expire", reason: order.orderType === "MARKET" ? "The market didn't open before the order expired" : "Day order expired at the close" };
    }
    if (!marketOpen || !quote) return { action: "none" };
    const { side, orderType, limitPrice, stopPrice } = order;
    let triggered = false;
    if ((orderType === "STOP" || orderType === "STOP_LIMIT") && !order.triggeredAt) {
        if (!stopReached(side, stopPrice!, quote.price)) return { action: "none" };
        triggered = true;
    }
    if (orderType === "MARKET" || orderType === "STOP") {
        return { action: "fill", ...fillPrice(side, quote), triggered };
    }
    const fill = limitFill(side, limitPrice!, quote);
    if (fill) return { action: "fill", ...fill, triggered };
    return triggered ? { action: "trigger" } : { action: "none" };
};

// The price an order is assumed to fill at for its reservation and placement check: the limit, else the stop, else the current price
export const reservationPrice = (order: Pick<OpenOrder, "limitPrice" | "stopPrice">, currentPrice: number | undefined): number | null =>
    order.limitPrice ?? order.stopPrice ?? currentPrice ?? null;

// The cash open orders hold back from available cash: each order that would open or add to a position (anything but a sale of a
// long or a cover of a short no larger than the position) reserves what it needs at its reservation price: a buy its cost, a short
// half its value (its proceeds cover the other 100% of the 150% collateral). Orders that only reduce a position reserve nothing.
export const reservedForOrders = (orders: OpenOrder[], positions: Position[], prices: Record<string, number>): number => {
    let reserved = 0;
    for (const order of orders) {
        const price = reservationPrice(order, prices[order.ticker]);
        // A dollar-amount order without a price is assumed to open a position
        const quantity = order.quantity ?? (price ? order.amount! / price : null);
        if (price !== null && quantity !== null && reducesPosition({ positions, trade: { type: order.side, ticker: order.ticker, price, quantity, total: quantity * price } })) continue;
        const value = order.amount ?? (price === null ? null : quantity! * price);
        if (value === null) continue;
        reserved += order.side === "BUY" ? value : value / 2;
    }
    return roundCents(reserved);
};
