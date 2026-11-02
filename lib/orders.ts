import { formatEastern } from "./marketHours";
import { contractMultiplier, contractName, isOptionSymbol, parseOptionSymbol } from "./options";
import type { BrokerOrder, BrokerOrderRequest } from "./types";

type OrderType = NonNullable<BrokerOrderRequest["type"]>;
type TimeInForce = NonNullable<BrokerOrderRequest["time_in_force"]>;

// Quantities are stored to 6 decimal places (fractional shares), money to cents
export type TradeMode = "shares" | "dollars";

export const roundShares = (shares: number): number => Math.round(shares * 1e6) / 1e6;
// Whole millionths of a share no larger than shares (the epsilon absorbs float error, such as 0.3 / 0.1 = 2.9999999999999996)
const floorShares = (shares: number): number => Math.floor(shares * 1e6 + 1e-6) / 1e6;
export const roundCents = (amount: number): number => Math.round(amount * 100) / 100;

export const formatShares = (shares: number | string): string => Number(shares).toLocaleString("en-US", { maximumFractionDigits: 6 });

// Turn the order input (a number of shares, or a dollar amount when mode is "dollars") into the quantity and total to trade.
// maxShares caps closing trades at the open position. A dollar amount buys whole millionths of a share, rounded down, and the total
// is always that quantity at the price, so rounding can't buy shares worth more than was paid; an order worth less than a cent is
// empty (quantity 0).
export const toOrder = ({ mode, value, price, maxShares = Infinity }: {
    mode: TradeMode;
    value: number;
    price: number | string | null;
    maxShares?: number;
}): { quantity: number; total: number } => {
    const tradePrice = parseFloat(String(price));
    if (!(tradePrice > 0) || !(value > 0)) {
        return { quantity: 0, total: 0 };
    }
    // An amount that covers the whole position closes it exactly, rather than leaving a sliver of a share open
    const quantity = mode === "dollars"
        ? (value >= roundCents(maxShares * tradePrice) ? maxShares : floorShares(value / tradePrice))
        : roundShares(Math.min(value, maxShares));
    const total = roundCents(quantity * tradePrice);
    return total >= 0.01 ? { quantity, total } : { quantity: 0, total: 0 };
};

// Convert the order input when switching modes, so the order stays the same size
export const convertValue = (toMode: TradeMode, value: number, price: number | string | null): number => {
    const tradePrice = parseFloat(String(price));
    if (!(tradePrice > 0)) return value;
    return toMode === "dollars" ? roundCents(value * tradePrice) : roundShares(value / tradePrice);
};

export const formatCurrency = (amount: number | string): string => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));
export const formatSigned = (amount: number): string => `${amount >= 0 ? "+" : "-"}${formatCurrency(Math.abs(amount))}`;
// A per-share price, to 2 decimals or up to 4 when it has them (fills at a simulated or sub-cent bid/ask)
export const formatPrice = (price: number | string): string =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(price));

export const ORDER_TYPE_LABELS: Record<OrderType, string> = { market: "Market", limit: "Limit", stop: "Stop", stop_limit: "Stop limit", trailing_stop: "Trailing stop" };

export const TIME_IN_FORCE_LABELS: Record<TimeInForce, string> = {
    day: "Day", gtc: "Until cancelled", opg: "At the open", cls: "At the close", ioc: "Immediate or cancel", fok: "Fill or kill"
};

// An order status as the pages show it
export const orderStatusLabel = (status: string): string =>
    ({ canceled: "Cancelled", partially_filled: "Partly filled", held: "Held", pending_cancel: "Cancelling", pending_replace: "Replacing", new: "Working" } as Record<string, string>)[status]
    ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");

// An order's type and prices, such as "Limit $180.00", "Stop $95.00, limit $94.00" or "Trailing stop 5% (stop $104.50)"
// What an order trades: a stock's symbol, an option contract's name, or an mleg order's underlying ("F spread")
export const orderSymbolLabel = ({ symbol, order_class, legs }: Pick<BrokerOrder, "symbol" | "order_class" | "legs">): string =>
    order_class === "mleg" ? `${parseOptionSymbol(legs?.[0]?.symbol ?? "")?.underlying ?? "Option"} spread` : contractName(symbol ?? "");

// An mleg order's net price: a debit or a credit per spread
const netPrice = (price: string | number) => `${formatPrice(Math.abs(Number(price)))} ${Number(price) >= 0 ? "debit" : "credit"}`;

export const describeOrderType = ({ type, limit_price, stop_price, trail_price, trail_percent, order_class }: Pick<BrokerOrder, "type" | "limit_price" | "stop_price" | "trail_price" | "trail_percent"> & { order_class?: BrokerOrder["order_class"] }): string => {
    if (order_class === "mleg") return type === "limit" ? `Net limit ${netPrice(limit_price!)}` : "Market";
    if (type === "stop_limit") return `Stop ${formatPrice(stop_price!)}, limit ${formatPrice(limit_price!)}`;
    if (type === "stop") return `Stop ${formatPrice(stop_price!)}`;
    if (type === "limit") return `Limit ${formatPrice(limit_price!)}`;
    if (type === "trailing_stop") {
        const trail = trail_percent ? `${Number(trail_percent)}%` : formatPrice(trail_price!);
        return `Trailing stop ${trail}${stop_price ? ` (stop ${formatPrice(stop_price)})` : ""}`;
    }
    return "Market";
};

// An order's size: shares, contracts (an option), spreads (an mleg order), or a dollar amount for a notional order
export const describeOrderSize = ({ qty, notional, symbol, order_class }: Pick<BrokerOrder, "qty" | "notional"> & { symbol?: string; order_class?: BrokerOrder["order_class"] }): string => {
    if (qty === null || qty === undefined) return formatCurrency(notional!);
    const one = Number(qty) === 1;
    const unit = order_class === "mleg" ? (one ? "spread" : "spreads") : isOptionSymbol(symbol ?? "") ? (one ? "contract" : "contracts") : one ? "share" : "shares";
    return `${formatShares(qty)} ${unit}`;
};

// What happened to an order just placed, for the order forms: filled (at its average price), part filled, working, accepted for
// the open (outside its session) or held (a bracket's legs wait for the entry)
export const describePlacedOrder = (order: BrokerOrder, { nextOpen }: { nextOpen?: string | null } = {}): { ok: boolean; message: string } => {
    const filled = Number(order.filled_qty ?? 0);
    const verb = order.side === "buy" ? "Bought" : "Sold";
    const label = orderSymbolLabel(order);
    const mleg = order.order_class === "mleg";
    const what = mleg ? `${label}, ${describeOrderSize(order)}` : `${order.side === "buy" ? "Buy" : "Sell"} ${describeOrderSize(order)} ${label}`;
    if (order.status === "filled") {
        if (mleg) return { ok: true, message: `${label} filled: ${describeOrderSize(order)} at ${netPrice(order.filled_avg_price!)} (${formatCurrency(filled * Math.abs(Number(order.filled_avg_price)) * 100)})` };
        return { ok: true, message: `${verb} ${formatShares(filled)} ${label} at ${formatPrice(order.filled_avg_price!)} (${formatCurrency(filled * Number(order.filled_avg_price) * contractMultiplier(order.symbol ?? ""))})` };
    }
    if (order.status === "rejected" || order.status === "canceled" || order.status === "expired") {
        return { ok: false, message: `${what} was ${order.status === "canceled" ? "cancelled" : order.status}${filled > 0 ? ` after filling ${formatShares(filled)}` : ""}` };
    }
    if (order.status === "partially_filled") {
        return { ok: true, message: `${verb} ${formatShares(filled)} of ${formatShares(order.qty!)} ${label} at ${formatPrice(order.filled_avg_price!)} so far; the rest is working` };
    }
    const legs = order.legs?.length && !mleg ? `, with ${order.legs.map(leg => leg.type === "limit" ? "a take profit" : "a stop loss").join(" and ")}` : "";
    const terms = `${describeOrderType(order).toLowerCase()}, ${TIME_IN_FORCE_LABELS[order.time_in_force!].toLowerCase()}${order.extended_hours ? ", extended hours" : ""}`;
    if (order.status === "accepted") {
        return { ok: true, message: `Accepted for ${order.time_in_force === "cls" ? "the close" : nextOpen ? `the open, ${formatEastern(nextOpen, { withDay: true })}` : "the open"}: ${what}, ${terms}${legs}.` };
    }
    return { ok: true, message: `Placed: ${what}, ${terms}${legs}.` };
};
