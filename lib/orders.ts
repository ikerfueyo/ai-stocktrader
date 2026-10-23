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

const ORDER_TYPE_LABELS = { MARKET: "Market", LIMIT: "Limit", STOP: "Stop", STOP_LIMIT: "Stop limit" } as const;

// An order's type and prices, such as "Limit $180.00" or "Stop $95.00, limit $94.00"
export const describeOrderType = ({ order_type, limit_price, stop_price }: { order_type: keyof typeof ORDER_TYPE_LABELS; limit_price: string | number | null; stop_price: string | number | null }): string => {
    if (order_type === "STOP_LIMIT") return `Stop ${formatPrice(stop_price!)}, limit ${formatPrice(limit_price!)}`;
    if (order_type === "STOP") return `Stop ${formatPrice(stop_price!)}`;
    if (order_type === "LIMIT") return `Limit ${formatPrice(limit_price!)}`;
    return ORDER_TYPE_LABELS[order_type];
};

// An order's size: shares, or a dollar amount for a dollar-amount market order
export const describeOrderSize = ({ quantity, amount }: { quantity: string | number | null; amount: string | number | null }): string =>
    quantity !== null ? `${formatShares(quantity)} ${Number(quantity) === 1 ? "share" : "shares"}` : formatCurrency(amount!);
