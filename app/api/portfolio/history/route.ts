import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { fetchDailyCloses } from "@/lib/server/marketData";
import { loadCorporateActions } from "@/lib/server/corporateActions";
import { cumulativeReturns, equityHistory, rebase } from "@/lib/server/history";
import { CASH_ACTIVITY_COLUMNS } from "@/lib/server/portfolio";
import { addDays, easternParts, isTradingDay } from "@/lib/marketHours";
import type { CashActivityRow, HistoryRange, PortfolioHistory, TransactionRow } from "@/lib/types";

const RANGES: HistoryRange[] = ["1W", "1M", "3M", "YTD", "1Y", "ALL"];
const BENCHMARK = "SPY";
// compact covers about the last 100 sessions
const COMPACT_DAYS = 140;

const rangeStart = (range: HistoryRange, today: string, first: string): string => {
    const days = { "1W": 7, "1M": 30, "3M": 91, "1Y": 365 } as Record<string, number>;
    const start = range === "ALL" ? first : range === "YTD" ? `${today.slice(0, 4)}-01-01` : addDays(today, -days[range]);
    return start > first ? start : first;
};

// Get the account's daily equity and time-weighted return (equityHistory) over ?range= (default 1M), with SPY's price return for
// comparison. It's rebuilt from the trades, the cash ledger, splits and each traded ticker's daily closes (Alpha Vantage, cached 12
// hours per ticker), so it covers days the app wasn't open. Returns are measured from the range's first day.
export const GET = withUser(async (request, context, userId) => {
    const requested = request.nextUrl.searchParams.get("range") as HistoryRange | null;
    const range: HistoryRange = requested && RANGES.includes(requested) ? requested : "1M";
    const label = "GET /api/portfolio/history";
    const [{ rows: trades }, { rows: cash }] = await Promise.all([
        pool.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]),
        pool.query<CashActivityRow>(`SELECT ${CASH_ACTIVITY_COLUMNS} FROM cash_activity WHERE user_id = $1 ORDER BY "date", id`, [userId])
    ]);
    const firstDates = [...trades, ...cash].map(({ date }) => easternParts(new Date(date)).dateKey).sort();
    if (firstDates.length === 0) {
        return NextResponse.json<PortfolioHistory>({ range, points: [], twr: null, benchmarkReturn: null, benchmark: BENCHMARK, missing: [] });
    }
    const today = easternParts(new Date()).dateKey;
    const first = firstDates[0];
    const outputsize = first < addDays(today, -COMPACT_DAYS) ? "full" : "compact";
    const tickers = [...new Set(trades.map(({ ticker }) => ticker.toUpperCase()))];
    const [{ splits }, ...results] = await Promise.all([
        loadCorporateActions(tickers),
        ...[BENCHMARK, ...tickers].map(ticker => fetchDailyCloses(ticker, outputsize).catch(error => {
            console.error(`${label}: ${ticker}: ${error.message}`);
            return null;
        }))
    ]);
    const [benchmarkCloses, ...tickerCloses] = results;
    const closes = Object.fromEntries(tickers.flatMap((ticker, index) => tickerCloses[index] ? [[ticker, tickerCloses[index]!]] : []));
    // Trading days from the first activity: the benchmark's bars, or the NYSE calendar if it couldn't be fetched
    const dates = benchmarkCloses ? Object.keys(benchmarkCloses).filter(date => date >= first).sort() : [];
    if (dates.length === 0) {
        for (let day = first; day <= today; day = addDays(day, 1)) if (isTradingDay(day)) dates.push(day);
    }
    const history = equityHistory({
        trades,
        cash: cash.map(({ date, type, amount }) => ({
            date,
            amount: (type === "DEPOSIT" || type === "DIVIDEND_IN" ? 1 : -1) * parseFloat(amount),
            external: type === "DEPOSIT" || type === "WITHDRAW"
        })),
        splits, closes, dates
    });
    const start = rangeStart(range, today, first);
    const shown = history.filter(({ date }) => date >= start);
    const shownDates = shown.map(({ date }) => date);
    const twr = rebase(shown.map(({ twr }) => twr));
    const benchmark = benchmarkCloses ? rebase(cumulativeReturns(benchmarkCloses, shownDates)) : shownDates.map(() => null);
    return NextResponse.json<PortfolioHistory>({
        range,
        points: shown.map(({ date, equity, netDeposits, defined }, index) => ({ date, equity, netDeposits, twr: defined ? twr[index] : null, benchmark: benchmark[index] })),
        twr: shown.some(({ defined }, index) => defined && index > 0) ? twr.at(-1) ?? null : null,
        benchmarkReturn: benchmark.at(-1) ?? null,
        benchmark: BENCHMARK,
        missing: tickers.filter(ticker => !closes[ticker])
    });
});
