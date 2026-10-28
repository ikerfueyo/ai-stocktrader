// Account math: positions and cash from the trade history, dividends owed, and the account's value at current prices. Margin, buying
// power and calls are the broker's (lib/server/broker/sim/margin.ts). Kept apart from the route handlers and lib/server/portfolio.ts
// (which connect to Postgres) so it can be unit tested.
import { easternParts } from "../marketHours";
import { contractMultiplier } from "../options";
import type { FillPolicy, Position, Quote, TradeType } from "../types";

// A trade as it's replayed: a transactions row (pg returns DECIMAL/NUMERIC columns as strings) or a new trade (numbers).
// A trade without a date is a new one, happening now.
export interface Trade {
    ticker: string;
    type: TradeType | string;
    price: string | number;
    quantity: string | number;
    total: string | number;
    date?: string | Date;
}

// A stock split: from exDate ("YYYY-MM-DD", Eastern), each share becomes factor shares (below 1 for a reverse split)
export interface Split {
    ticker: string;
    exDate: string;
    factor: number;
}

// A cash dividend per share, owed to whoever holds the stock at the open on exDate (longs receive it, shorts pay it), paid on
// paymentDate (exDate when Alpha Vantage doesn't give one)
export interface Dividend {
    ticker: string;
    exDate: string;
    paymentDate: string | null;
    amount: number;
}

// A dividend to post to the cash ledger: received on a long (DIVIDEND_IN) or charged to a short (DIVIDEND_OUT)
export interface DividendPosting {
    type: "DIVIDEND_IN" | "DIVIDEND_OUT";
    ticker: string;
    exDate: string;
    shares: number;
    perShare: number;
    total: number;
}

// Current prices by ticker. A ticker can be missing when its price couldn't be fetched and there's no last known price.
export type Prices = Record<string, number>;

interface AccountState {
    positions: Position[];
    totalCash: number;
    prices: Prices;
    // Tickers priced from a last known price because their current price couldn't be fetched
    staleTickers?: string[];
}

// Quantities are stored to 6 decimal places (fractional shares); rounding stops float drift from leaving a 1e-17 position open
export const roundShares = (shares: number): number => Math.round(shares * 1e6) / 1e6;
export const roundCents = (amount: number): number => Math.round(amount * 100) / 100;
// Prices are stored to 6 decimals; fills are kept to 4, as Alpha Vantage quotes them
export const roundPrice = (price: number): number => Math.round(price * 1e4) / 1e4;

// The price a market order fills at: buys at the ask and sells at the bid (quoted or simulated), or the last price when the quote
// has no bid/ask
export const fillPrice = (type: TradeType, quote: Pick<Quote, "price" | "bid" | "ask" | "spread">): { price: number; fillPolicy: FillPolicy } => {
    const side = type === "BUY" ? quote.ask : quote.bid;
    if (side === null || quote.spread === "none") return { price: roundPrice(quote.price), fillPolicy: "LAST" };
    const simulated = quote.spread === "simulated";
    return { price: roundPrice(side), fillPolicy: type === "BUY" ? (simulated ? "SIM_ASK" : "ASK") : (simulated ? "SIM_BID" : "BID") };
};

export const formatCurrency = (amount: number): string => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

const tradeDay = (date: string | Date): string => easternParts(new Date(date)).dateKey;

// One trade applied to a position at average cost: adding re-averages it, reducing keeps the average, and a trade that flips the
// side opens the remainder at the trade price. realized is the P&L on the part that reduced or closed the position, against its
// average cost ((price - avgCost) x shares for a long, the reverse for a short), or null if the trade only opened or added.
export const applyTrade = (position: Position, { type, price, quantity }: { type: TradeType | string; price: number; quantity: number }): { position: Position; realized: number | null } => {
    const next = { ...position };
    const delta = type === "BUY" ? quantity : -quantity;
    const held = Math.abs(next.quantity);
    let realized: number | null = null;
    if (next.quantity !== 0 && Math.sign(delta) !== Math.sign(next.quantity)) {
        const closed = Math.min(quantity, held);
        realized = (next.quantity > 0 ? price - next.avgCost : next.avgCost - price) * closed;
    }
    if (next.quantity === 0 || Math.sign(delta) === Math.sign(next.quantity)) {
        next.avgCost = (next.avgCost * held + price * quantity) / (held + quantity);
        next.quantity = roundShares(next.quantity + delta);
    } else if (quantity <= held) {
        // Closing part of the position doesn't change its average cost
        next.quantity = roundShares(next.quantity + delta);
        if (next.quantity === 0) next.avgCost = 0;
    } else {
        // The trade flips the position; the leftover opens a new one at the trade price
        next.quantity = roundShares(next.quantity + delta);
        next.avgCost = price;
    }
    return { position: next, realized };
};

// The positions after a trade (applyTrade on its ticker's position), without any that it closed
export const addTrade = (positions: Position[], trade: Trade): Position[] => {
    const symbol = trade.ticker.toUpperCase();
    const current = positions.find(({ ticker }) => ticker === symbol) ?? { ticker: symbol, quantity: 0, avgCost: 0 };
    const { position } = applyTrade(current, { type: trade.type, price: parseFloat(String(trade.price)), quantity: parseFloat(String(trade.quantity)) });
    return [...positions.filter(({ ticker }) => ticker !== symbol), position].filter(({ quantity }) => quantity !== 0);
};

// Net transactions (oldest first) into one position per ticker, using average cost (applyTrade), and total their cash flow.
// quantity is signed: sells past zero open a short (negative quantity).
// cash is a plain ledger: every sell credits its total (including a short sale's proceeds) and every buy debits it
// (including a cover). Add net cash activity (deposits, withdrawals, dividends) to get the account's total cash.
// Splits are applied in date order, before the first trade on or after their date: a position's shares are multiplied by the
// factor and its average cost divided by it, so its cost basis, value and cash don't change.
// With before ("YYYY-MM-DD"), only trades dated before that day count, with the splits up to and including it: the position
// held at that day's open (positionsAt). Otherwise every trade counts, with the splits up to asOf's date. splitsThrough
// ("YYYY-MM-DD") sets the last split date applied instead, such as the trades before tomorrow with today's splits only: the
// position at today's close.
// Realized P&L is booked on the part of a trade that reduces or closes a position, against its average cost: (price - avgCost) x
// shares for a long, (avgCost - price) x shares for a short. realized has each transaction's amount, by index (null for a trade
// that only opened or added, or that a before date left out).
export const computePositions = (transactions: Trade[], splits: Split[] = [], { asOf = new Date(), before, splitsThrough }: { asOf?: Date; before?: string; splitsThrough?: string } = {}): { positions: Position[]; cash: number; realizedPnl: number; realized: (number | null)[] } => {
    const positions = new Map<string, Position>();
    let cash = 0;
    let realizedPnl = 0;
    const realized: (number | null)[] = transactions.map(() => null);
    const today = tradeDay(asOf);
    const lastSplitDay = splitsThrough ?? before ?? today;
    const pending = splits.filter(({ exDate }) => exDate <= lastSplitDay).sort((a, b) => a.exDate.localeCompare(b.exDate));
    let nextSplit = 0;
    const applySplitsThrough = (day: string) => {
        for (; nextSplit < pending.length && pending[nextSplit].exDate <= day; nextSplit++) {
            const { ticker, factor } = pending[nextSplit];
            const position = positions.get(ticker.toUpperCase());
            if (!position || position.quantity === 0 || !(factor > 0)) continue;
            position.quantity = roundShares(position.quantity * factor);
            position.avgCost = position.avgCost / factor;
        }
    };
    transactions.forEach(({ ticker, type, price, quantity: storedQuantity, total, date }, index) => {
        const day = date ? tradeDay(date) : today;
        if (before !== undefined && day >= before) return;
        applySplitsThrough(day);
        const symbol = ticker.toUpperCase();
        // pg returns NUMERIC columns as strings
        cash += type === "SELL" ? parseFloat(String(total)) : -parseFloat(String(total));
        const { position, realized: gain } = applyTrade(positions.get(symbol) ?? { ticker: symbol, quantity: 0, avgCost: 0 }, {
            type, price: parseFloat(String(price)), quantity: parseFloat(String(storedQuantity))
        });
        if (gain !== null) {
            realized[index] = roundCents(gain);
            realizedPnl += gain;
        }
        positions.set(symbol, position);
    });
    applySplitsThrough(lastSplitDay);
    return { positions: [...positions.values()].filter(position => position.quantity !== 0), cash, realizedPnl: roundCents(realizedPnl), realized };
};

// The positions held at the open of a day ("YYYY-MM-DD"): trades before it, splits through it
export const positionsAt = (transactions: Trade[], splits: Split[], day: string): Position[] => computePositions(transactions, splits, { before: day }).positions;

// The dividends to post: each one whose payment date has come (by asOf), on a ticker held long or short at its ex-date's open,
// that isn't already posted (posted holds "TICKER|exDate" keys). Shares are split-adjusted to the ex-date.
export const planDividends = ({ transactions, splits, dividends, posted, asOf = new Date() }: {
    transactions: Trade[];
    splits: Split[];
    dividends: Dividend[];
    posted: Set<string>;
    asOf?: Date;
}): DividendPosting[] => {
    const today = tradeDay(asOf);
    const postings: DividendPosting[] = [];
    for (const { ticker, exDate, paymentDate, amount } of dividends) {
        const symbol = ticker.toUpperCase();
        if ((paymentDate ?? exDate) > today || posted.has(`${symbol}|${exDate}`) || !(amount > 0)) continue;
        const trades = transactions.filter(trade => trade.ticker.toUpperCase() === symbol);
        const held = positionsAt(trades, splits, exDate).find(position => position.ticker === symbol)?.quantity ?? 0;
        if (held === 0) continue;
        const total = roundCents(Math.abs(held) * amount);
        if (total <= 0) continue;
        postings.push({ type: held > 0 ? "DIVIDEND_IN" : "DIVIDEND_OUT", ticker: symbol, exDate, shares: Math.abs(held), perShare: amount, total });
    }
    return postings;
};

// The account's value at current prices (prices maps ticker to price; a position missing from it is valued at its average cost):
//   equity         = total cash + long market value - short market value
//   unrealized P&L = (long market value - long cost basis) + (short-sale proceeds - short market value)
// With average cost, a position's cost basis (or a short's original proceeds) is avgCost x shares (an option's contracts x 100). Tickers in staleTickers (priced
// from a last known price) or missing from prices (priced at average cost) are listed in missingPrices.
export const valueAccount = ({ positions, totalCash, prices, staleTickers = [] }: AccountState) => {
    let longValue = 0;
    let longCostBasis = 0;
    let shortProceeds = 0;
    let shortValue = 0;
    for (const { ticker, quantity, avgCost } of positions) {
        const price = prices[ticker] ?? avgCost;
        const shares = Math.abs(quantity) * contractMultiplier(ticker);
        if (quantity > 0) {
            longValue += shares * price;
            longCostBasis += shares * avgCost;
        } else {
            shortProceeds += shares * avgCost;
            shortValue += shares * price;
        }
    }
    return {
        totalCash: roundCents(totalCash),
        equity: roundCents(totalCash + longValue - shortValue),
        unrealizedPnl: roundCents((longValue - longCostBasis) + (shortProceeds - shortValue)),
        longMarketValue: roundCents(longValue),
        shortMarketValue: roundCents(shortValue),
        missingPrices: positions.map(({ ticker }) => ticker).filter(ticker => staleTickers.includes(ticker) || prices[ticker] === undefined)
    };
};

// Whether a trade only reduces an open position (selling part of a long, or covering part of a short)
export const reducesPosition = ({ positions, trade }: { positions: Position[]; trade: Trade }): boolean => {
    const held = positions.find(position => position.ticker === trade.ticker.toUpperCase())?.quantity ?? 0;
    const quantity = parseFloat(String(trade.quantity));
    return trade.type === "BUY" ? held < 0 && quantity <= -held : held > 0 && quantity <= held;
};
