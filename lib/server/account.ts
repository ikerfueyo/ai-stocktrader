// Account math: positions and cash from the trade history, the account's value at current prices, short collateral,
// and which trades and withdrawals are allowed. Kept apart from the route handlers and lib/server/portfolio.ts (which connect
// to Postgres) so it can be unit tested.
import type { AccountValuation, MarginStatus, Position, TradeType } from "../types";

// A trade as it's replayed: a transactions row (pg returns DECIMAL/NUMERIC columns as strings) or a new trade (numbers)
export interface Trade {
    ticker: string;
    type: TradeType | string;
    price: string | number;
    quantity: string | number;
    total: string | number;
}

// A trade planned by planBuyIn, at a current price rounded to the cent
export interface PlannedTrade {
    type: TradeType;
    ticker: string;
    price: number;
    quantity: number;
    total: number;
}

// Current prices by ticker. A ticker can be missing when its price couldn't be fetched and there's no last known price.
export type Prices = Record<string, number>;

// Whether a trade or withdrawal may go ahead, and if not, the HTTP status and message to reject it with
export type Assessment = { allowed: true } | { allowed: false; status: number; message: string };

interface AccountState {
    positions: Position[];
    totalCash: number;
    prices: Prices;
    // Tickers priced from a last known price because their current price couldn't be fetched
    staleTickers?: string[];
}

// Short collateral: 150% of the shorts' current market value must be held from total cash as restricted cash.
// Below 150% the account is in a margin call; below 130% shorts are bought in automatically to restore 150%.
export const SHORT_COLLATERAL_RATE = 1.5;
export const BUY_IN_RATE = 1.3;
// Stored totals are rounded to the cent, so checks allow half a cent of slack
const CENT_SLACK = 0.005;

// Quantities are stored to 6 decimal places (fractional shares); rounding stops float drift from leaving a 1e-17 position open
export const roundShares = (shares: number): number => Math.round(shares * 1e6) / 1e6;
// Round up to 6 decimals, ignoring float noise such as 2.0000000000000004
const ceilShares = (shares: number): number => Math.ceil(shares * 1e6 - 1e-6) / 1e6;
export const roundCents = (amount: number): number => Math.round(amount * 100) / 100;

export const formatCurrency = (amount: number): string => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

// Net transactions (oldest first) into one position per ticker, using average cost, and total their cash flow.
// quantity is signed: sells past zero open a short (negative quantity).
// cash is a plain ledger: every sell credits its total (including a short sale's proceeds) and every buy debits it
// (including a cover). Add net deposits to get the account's total cash.
export const computePositions = (transactions: Trade[]): { positions: Position[]; cash: number } => {
    const positions = new Map<string, Position>();
    let cash = 0;
    for (const { ticker, type, price, quantity: storedQuantity, total } of transactions) {
        const symbol = ticker.toUpperCase();
        const position = positions.get(symbol) ?? { ticker: symbol, quantity: 0, avgCost: 0 };
        const tradePrice = parseFloat(String(price));
        // pg returns NUMERIC columns as strings
        const quantity = parseFloat(String(storedQuantity));
        cash += type === "SELL" ? parseFloat(String(total)) : -parseFloat(String(total));
        const delta = type === "BUY" ? quantity : -quantity;
        const held = Math.abs(position.quantity);
        if (position.quantity === 0 || Math.sign(delta) === Math.sign(position.quantity)) {
            position.avgCost = (position.avgCost * held + tradePrice * quantity) / (held + quantity);
            position.quantity = roundShares(position.quantity + delta);
        } else if (quantity <= held) {
            // Closing part of the position doesn't change its average cost
            position.quantity = roundShares(position.quantity + delta);
            if (position.quantity === 0) position.avgCost = 0;
        } else {
            // The trade flips the position; the leftover opens a new one at the trade price
            position.quantity = roundShares(position.quantity + delta);
            position.avgCost = tradePrice;
        }
        positions.set(symbol, position);
    }
    return { positions: [...positions.values()].filter(position => position.quantity !== 0), cash };
};

// Unrounded totals behind valueAccount. A position missing from prices is valued at its average cost.
const measure = ({ positions, totalCash, prices, collateralRate = SHORT_COLLATERAL_RATE }: AccountState & { collateralRate?: number }) => {
    let longValue = 0;
    let longCostBasis = 0;
    let shortProceeds = 0;
    let shortLiability = 0;
    for (const { ticker, quantity, avgCost } of positions) {
        const price = prices[ticker] ?? avgCost;
        const shares = Math.abs(quantity);
        if (quantity > 0) {
            longValue += shares * price;
            longCostBasis += shares * avgCost;
        } else {
            shortProceeds += shares * avgCost;
            shortLiability += shares * price;
        }
    }
    const requirement = collateralRate * shortLiability;
    return { longValue, longCostBasis, shortProceeds, shortLiability, requirement, shortfall: Math.max(0, requirement - totalCash) };
};

// Value the account at current prices (prices maps ticker to price).
//   equity         = total cash + long market value - short market liability
//   unrealized P&L = (long market value - long cost basis) + (short-sale proceeds - short market liability)
//   requirement    = 150% of short market liability, held from total cash as restricted cash; the rest is available cash
// With average cost, a position's cost basis (or a short's original proceeds) is avgCost x shares.
// The requirement only splits total cash, so it changes neither equity nor unrealized P&L. When total cash can't meet it, the gap
// is a collateral shortfall: the deposit that would make the account compliant. Available cash is never negative.
// Tickers in staleTickers (priced from a last known price) or missing from prices (priced at average cost) are listed in missingPrices.
export const valueAccount = ({ positions, totalCash, prices, staleTickers = [], collateralRate = SHORT_COLLATERAL_RATE }: AccountState & { collateralRate?: number }): AccountValuation => {
    const { longValue, longCostBasis, shortProceeds, shortLiability, requirement, shortfall } = measure({ positions, totalCash, prices, collateralRate });
    let marginStatus: MarginStatus = "ok";
    if (shortfall > CENT_SLACK) {
        marginStatus = shortLiability > 0 && totalCash < BUY_IN_RATE * shortLiability ? "buy_in" : "margin_call";
    }
    return {
        totalCash: roundCents(totalCash),
        equity: roundCents(totalCash + longValue - shortLiability),
        unrealizedPnl: roundCents((longValue - longCostBasis) + (shortProceeds - shortLiability)),
        shortLiability: roundCents(shortLiability),
        collateralRequirement: roundCents(requirement),
        restrictedCash: roundCents(Math.min(requirement, Math.max(totalCash, 0))),
        availableCash: roundCents(Math.max(0, totalCash - requirement)),
        collateralShortfall: marginStatus === "ok" ? 0 : roundCents(shortfall),
        collateralRatio: shortLiability > 0 ? totalCash / shortLiability : null,
        marginStatus,
        missingPrices: positions.map(({ ticker }) => ticker).filter(ticker => staleTickers.includes(ticker) || prices[ticker] === undefined)
    };
};

// Whether a trade only reduces an open position (selling part of a long, or covering part of a short)
export const reducesPosition = ({ positions, trade }: { positions: Position[]; trade: Trade }): boolean => {
    const held = positions.find(position => position.ticker === trade.ticker.toUpperCase())?.quantity ?? 0;
    const quantity = parseFloat(String(trade.quantity));
    return trade.type === "BUY" ? held < 0 && quantity <= -held : held > 0 && quantity <= held;
};

const marginCallMessage = (shortfall: number) =>
    `Margin call: your account has a ${formatCurrency(shortfall)} collateral shortfall, so until it's fixed only covers, sales of long positions and deposits are allowed`;

// Short tickers whose collateral can't be checked because they have no current price
const unpricedShorts = (positions: Position[], prices: Prices, staleTickers: string[]) => positions
    .filter(({ ticker, quantity }) => quantity < 0 && (staleTickers.includes(ticker) || prices[ticker] === undefined))
    .map(({ ticker }) => ticker);

const unpricedResult = (tickers: string[]): Assessment =>
    ({ allowed: false, status: 502, message: `Couldn't get a current price for ${tickers.join(", ")} to check collateral; try again shortly` });

// Whether a trade may go ahead. Returns { allowed: true } or { allowed: false, status, message }.
// A trade that only reduces a position is always allowed, and is paid from total cash, restricted cash included.
// Anything that opens or adds to a position (including the new side of a flip) must leave no collateral shortfall, judged by
// replaying the history with the trade added, with the traded ticker at the trade price and the others at current prices.
// So a buy needs its cost in available cash, and a new short needs 50% of its value (its proceeds cover the other 100%).
export const assessTrade = ({ transactions, netTransfers = 0, prices, staleTickers = [], trade }: {
    transactions: Trade[];
    netTransfers?: number;
    prices: Prices;
    staleTickers?: string[];
    trade: Trade;
}): Assessment => {
    const symbol = trade.ticker.toUpperCase();
    const before = computePositions(transactions);
    if (reducesPosition({ positions: before.positions, trade })) {
        return { allowed: true };
    }
    const after = computePositions([...transactions, trade]);
    const tradePrices = { ...prices, [symbol]: parseFloat(String(trade.price)) };
    const stale = staleTickers.filter(ticker => ticker !== symbol);
    const unpriced = unpricedShorts(after.positions, tradePrices, stale);
    if (unpriced.length > 0) {
        return unpricedResult(unpriced);
    }
    const shortfallAfter = measure({ positions: after.positions, totalCash: after.cash + netTransfers, prices: tradePrices }).shortfall;
    if (shortfallAfter <= CENT_SLACK) {
        return { allowed: true };
    }
    const valuedBefore = valueAccount({ positions: before.positions, totalCash: before.cash + netTransfers, prices: tradePrices, staleTickers: stale });
    if (valuedBefore.collateralShortfall > 0) {
        return { allowed: false, status: 400, message: marginCallMessage(valuedBefore.collateralShortfall) };
    }
    const available = valuedBefore.availableCash;
    const needed = formatCurrency(available + shortfallAfter);
    const message = trade.type === "BUY"
        ? `Insufficient funds: buying ${symbol} needs ${needed} available, but only ${formatCurrency(available)} is`
        : `Insufficient collateral: shorting ${symbol} needs ${needed} available (150% of a short's value is held as collateral, and its proceeds cover 100%), but only ${formatCurrency(available)} is`;
    return { allowed: false, status: 400, message };
};

// Whether a withdrawal may go ahead: it can only come from available cash, never from short collateral.
export const assessWithdrawal = ({ positions, totalCash, prices, staleTickers = [], amount }: AccountState & { amount: number }): Assessment => {
    const unpriced = unpricedShorts(positions, prices, staleTickers);
    if (unpriced.length > 0) {
        return unpricedResult(unpriced);
    }
    const valued = valueAccount({ positions, totalCash, prices });
    if (valued.collateralShortfall > 0) {
        return { allowed: false, status: 400, message: marginCallMessage(valued.collateralShortfall) };
    }
    if (amount > valued.availableCash + CENT_SLACK) {
        const held = valued.restrictedCash > 0 ? ` (${formatCurrency(valued.restrictedCash)} is held as short collateral)` : "";
        return { allowed: false, status: 400, message: `Insufficient funds: can't withdraw ${formatCurrency(amount)}, only ${formatCurrency(valued.availableCash)} is available${held}` };
    }
    return { allowed: true };
};

// The automatic buy-in for an account whose total cash is below 130% of its short liability. Returns { trades, remainingDeficit }.
// Covers the same fraction of every short, just enough to restore 150% (covering $V costs $V but releases $1.5V of requirement,
// so it takes $2 of covers per $1 of shortfall). If even covering every short leaves negative cash, longs are sold pro rata
// to clear it; whatever is still negative is remainingDeficit. Trades are at current prices rounded to the cent, with
// shares rounded up. Nothing is planned while a short has no current price.
export const planBuyIn = ({ positions, totalCash, prices, staleTickers = [] }: AccountState): { trades: PlannedTrade[]; remainingDeficit: number } => {
    const none = { trades: [], remainingDeficit: 0 };
    const shorts = positions.filter(({ quantity }) => quantity < 0);
    if (shorts.length === 0 || unpricedShorts(positions, prices, staleTickers).length > 0) return none;
    const { shortLiability, shortfall } = measure({ positions, totalCash, prices });
    if (totalCash >= BUY_IN_RATE * shortLiability) return none;

    const tradeAt = (type: TradeType, ticker: string, shares: number): PlannedTrade => {
        const price = roundCents(prices[ticker]);
        return { type, ticker, price, quantity: shares, total: roundCents(shares * price) };
    };
    // Rounding prices and totals to the cent can leave the first estimate a little short, so retry with the remaining gap
    let coverValue = 2 * shortfall + 0.02;
    let covers: PlannedTrade[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        const fraction = Math.min(1, coverValue / shortLiability);
        covers = shorts.map(({ ticker, quantity }) => tradeAt("BUY", ticker, Math.min(-quantity, ceilShares(fraction * -quantity))));
        const after = positions.map(position => {
            const cover = covers.find(trade => trade.ticker === position.ticker);
            return cover ? { ...position, quantity: roundShares(position.quantity + cover.quantity) } : position;
        });
        const cashAfter = totalCash - covers.reduce((sum, trade) => sum + trade.total, 0);
        const gap = measure({ positions: after, totalCash: cashAfter, prices }).shortfall;
        if (gap <= CENT_SLACK || fraction === 1) break;
        coverValue += 2 * gap + 0.02;
    }
    const coveredAll = covers.every((trade, i) => trade.quantity === -shorts[i].quantity);
    covers = covers.filter(trade => trade.quantity > 0);
    let cash = totalCash - covers.reduce((sum, trade) => sum + trade.total, 0);

    let sales: PlannedTrade[] = [];
    if (coveredAll && cash < 0) {
        const longs = positions.filter(({ ticker, quantity }) => quantity > 0 && !staleTickers.includes(ticker) && prices[ticker] !== undefined);
        const longValue = longs.reduce((sum, { ticker, quantity }) => sum + quantity * roundCents(prices[ticker]), 0);
        if (longValue > 0) {
            const fraction = Math.min(1, (-cash + 0.01) / longValue);
            sales = longs.map(({ ticker, quantity }) => tradeAt("SELL", ticker, Math.min(quantity, ceilShares(fraction * quantity))))
                .filter(trade => trade.quantity > 0);
            cash += sales.reduce((sum, trade) => sum + trade.total, 0);
        }
    }
    return { trades: [...covers, ...sales], remainingDeficit: roundCents(Math.max(0, -cash)) };
};
