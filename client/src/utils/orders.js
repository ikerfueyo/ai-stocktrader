// Quantities are stored to 6 decimal places (fractional shares), money to cents
export const roundShares = (shares) => Math.round(shares * 1e6) / 1e6;
export const roundCents = (amount) => Math.round(amount * 100) / 100;

export const formatShares = (shares) => Number(shares).toLocaleString("en-US", { maximumFractionDigits: 6 });

// Turn the order input (a number of shares, or a dollar amount when mode is "dollars") into the quantity and total to trade.
// maxShares caps closing trades at the open position.
export const toOrder = ({ mode, value, price, maxShares = Infinity }) => {
    const tradePrice = parseFloat(price);
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
export const convertValue = (toMode, value, price) => {
    const tradePrice = parseFloat(price);
    if (!(tradePrice > 0)) return value;
    return toMode === "dollars" ? roundCents(value * tradePrice) : roundShares(value / tradePrice);
};

export const formatCurrency = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
export const formatSigned = (amount) => `${amount >= 0 ? "+" : "-"}${formatCurrency(Math.abs(amount))}`;
