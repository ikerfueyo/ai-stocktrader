// The account's daily equity and time-weighted return, rebuilt from the trade history, the cash ledger and daily closes. Pure, so
// it can be unit tested; GET /api/portfolio/history supplies the data.
import { computePositions, roundCents, type Split, type Trade } from "./account";
import { addDays, easternParts } from "../marketHours";

// A cash_activity entry: amount is signed (+ in, - out). external marks deposits and withdrawals, which move equity without being
// investment return; dividends aren't external, so they count as return.
export interface CashFlow {
    date: string | Date;
    amount: number;
    external: boolean;
}

export interface HistoryPoint {
    date: string;
    equity: number;
    // Deposits less withdrawals so far
    netDeposits: number;
    // Time-weighted return since the first point, as a fraction (0.05 = 5%)
    twr: number;
    // False on a day that started or ended (before deposits and withdrawals) with zero or negative equity, when the day's return
    // isn't meaningful (it adds nothing to twr)
    defined: boolean;
}

const dayOf = (date: string | Date) => easternParts(new Date(date)).dateKey;

// Each ticker's close on each of dates, carried forward over days without a bar (missing before its first bar)
const closesByDate = (closes: Record<string, Record<string, number>>, dates: string[]) => {
    const filled: Record<string, Record<string, number>> = {};
    for (const [ticker, series] of Object.entries(closes)) {
        const known = Object.keys(series).sort();
        filled[ticker] = {};
        let next = 0;
        let last: number | undefined;
        for (const date of dates) {
            for (; next < known.length && known[next] <= date; next++) last = series[known[next]];
            if (last !== undefined) filled[ticker][date] = last;
        }
    }
    return filled;
};

// Daily equity at each date's close: cash (the trades' ledger plus cash activity through that day) plus each position (trades
// through that day, splits through it, not the next day's) at that day's close, or its average cost without one. The time-weighted
// return chains each day's return with the deposits and withdrawals since the previous date taken out (weekends and holidays
// included), (equity - flows) / previous equity - 1, so moving money in or out doesn't count as performance. A return is only meaningful while the account has positive equity, so a day that starts or ends
// (before that day's flows) at zero or below adds nothing to the chain and is marked not defined; otherwise a few dollars of equity
// turning negative would read as a loss of several hundred percent.
export const equityHistory = ({ trades, cash, splits = [], closes, dates }: {
    trades: Trade[];
    cash: CashFlow[];
    splits?: Split[];
    closes: Record<string, Record<string, number>>;
    dates: string[];
}): HistoryPoint[] => {
    const prices = closesByDate(closes, dates);
    const flows = cash.map(flow => ({ ...flow, day: dayOf(flow.date) }));
    const points: HistoryPoint[] = [];
    let growth = 1;
    let previousEquity = 0;
    let previousDate = "";
    for (const date of dates) {
        const { positions, cash: tradeCash } = computePositions(trades, splits, { before: addDays(date, 1), splitsThrough: date });
        const activity = flows.filter(({ day }) => day <= date);
        const netCash = activity.reduce((sum, { amount }) => sum + amount, 0);
        const netDeposits = activity.filter(({ external }) => external).reduce((sum, { amount }) => sum + amount, 0);
        const todaysFlows = activity.filter(({ day, external }) => external && day > previousDate).reduce((sum, { amount }) => sum + amount, 0);
        const holdings = positions.reduce((sum, { ticker, quantity, avgCost }) => sum + quantity * (prices[ticker]?.[date] ?? avgCost), 0);
        const equity = tradeCash + netCash + holdings;
        const defined = previousEquity > 0 && equity - todaysFlows > 0;
        if (defined) growth *= (equity - todaysFlows) / previousEquity;
        previousEquity = equity;
        previousDate = date;
        points.push({ date, equity: roundCents(equity), netDeposits: roundCents(netDeposits), twr: growth - 1, defined });
    }
    return points;
};

// A price series' cumulative return at each date since the first date with a price, as fractions
export const cumulativeReturns = (series: Record<string, number>, dates: string[]): (number | null)[] => {
    const filled = closesByDate({ series }, dates).series;
    const base = dates.map(date => filled[date]).find(price => price !== undefined);
    return dates.map(date => base === undefined || filled[date] === undefined ? null : filled[date] / base - 1);
};

// Rebases cumulative returns so the first value is 0: the return since that point
export const rebase = (returns: (number | null)[]): (number | null)[] => {
    const start = returns.find(value => value !== null);
    return returns.map(value => value === null || start === undefined || start === null ? null : (1 + value) / (1 + start) - 1);
};
