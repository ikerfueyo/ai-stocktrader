// Quantities are stored to 6 decimal places (fractional shares), money to cents
export type TradeMode = "shares" | "dollars";

export const roundShares = (shares: number): number => Math.round(shares * 1e6) / 1e6;
export const roundCents = (amount: number): number => Math.round(amount * 100) / 100;

export const formatShares = (shares: number | string): string => Number(shares).toLocaleString("en-US", { maximumFractionDigits: 6 });

// Turn the order input (a number of shares, or a dollar amount when mode is "dollars") into the quantity and total to trade.
// maxShares caps closing trades at the open position.
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
    if (mode === "dollars") {
        // An amount that covers the whole position closes it exactly, rather than leaving a sliver of a share open
        const maxTotal = roundCents(maxShares * tradePrice);
        if (value >= maxTotal) {
            return { quantity: maxShares, total: maxTotal };
        }
        return { quantity: roundShares(value / tradePrice), total: roundCents(value) };
    }
    const quantity = roundShares(Math.min(value, maxShares));
    return { quantity, total: roundCents(quantity * tradePrice) };
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
