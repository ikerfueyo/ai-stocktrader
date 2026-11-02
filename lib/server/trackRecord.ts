// How past ticker verdicts turned out: each logged verdict's price return over the sessions after it (from baselineDate), against the benchmark's
// (SPY) between the same closes. Pure, so it can be unit tested; the route loads the log, the closes and the stored splits.
import type { Split } from "./account";
import type { TickerVerdict, TrackRecord, VerdictOutcome } from "../types";

// A verdict_log row, one per prompt version, ticker and session (the route keeps the last of each)
export interface LoggedVerdict {
    ticker: string;
    verdict: TickerVerdict;
    priceDate: string;
    // The Eastern date the verdict was made: its baseline is never a close before it, since its news can be newer than the
    // closes it saw (cached for hours)
    generatedDay?: string;
    promptVersion: number;
}

// The session whose close a verdict is scored from: the first on or after both the newest close it saw and the day it was made
export const baselineDate = ({ priceDate, generatedDay }: Pick<LoggedVerdict, "priceDate" | "generatedDay">, dates: string[]): string | null => {
    const from = generatedDay && generatedDay > priceDate ? generatedDay : priceDate;
    return dates.find(date => date >= from) ?? null;
};

export const TRACK_HORIZONS = [5, 20];
const VERDICTS: TickerVerdict[] = ["BUY", "HOLD", "SELL"];

const average = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

// The return from the close of date to the close sessions later, splits in between undone (daily closes aren't adjusted for
// them); null without that many sessions since, or without a close on date
export const forwardReturn = (closes: Record<string, number>, dates: string[], date: string, sessions: number, splits: Split[] = []) => {
    const start = dates.indexOf(date);
    if (start < 0 || start + sessions >= dates.length) return null;
    const end = dates[start + sessions];
    const factor = splits.filter(({ exDate }) => exDate > date && exDate <= end).reduce((product, split) => product * split.factor, 1);
    return closes[end] * factor / closes[date] - 1;
};

// Outcomes per prompt version (newest first) and horizon. BUY's hit rate is the share that beat the benchmark and SELL's the share
// that trailed it; HOLD has none. Tickers without closes are left out.
export const scoreVerdicts = (
    logged: LoggedVerdict[], closesByTicker: Record<string, Record<string, number>>, benchmarkCloses: Record<string, number> | null, splits: Split[] = []
): TrackRecord["versions"] => {
    const sortedDates = new Map(Object.entries(closesByTicker).map(([ticker, closes]) => [ticker, Object.keys(closes).sort()]));
    const versions = [...new Set(logged.map(({ promptVersion }) => promptVersion))].sort((a, b) => b - a);
    return versions.map(promptVersion => {
        const rows = logged.filter(row => row.promptVersion === promptVersion);
        const horizons = TRACK_HORIZONS.map(sessions => {
            const outcomes = VERDICTS.map((verdict): VerdictOutcome => {
                const returns: number[] = [];
                const excess: number[] = [];
                for (const row of rows.filter(row => row.verdict === verdict)) {
                    const closes = closesByTicker[row.ticker];
                    if (!closes) continue;
                    const dates = sortedDates.get(row.ticker)!;
                    const base = baselineDate(row, dates);
                    if (base === null) continue;
                    const stockReturn = forwardReturn(closes, dates, base, sessions, splits.filter(split => split.ticker === row.ticker));
                    if (stockReturn === null) continue;
                    returns.push(stockReturn);
                    // The benchmark between the same two closes
                    const end = dates[dates.indexOf(base) + sessions];
                    if (benchmarkCloses?.[base] && benchmarkCloses[end]) {
                        excess.push(stockReturn - (benchmarkCloses[end] / benchmarkCloses[base] - 1));
                    }
                }
                const beat = verdict === "BUY" ? excess.filter(value => value > 0) : excess.filter(value => value < 0);
                return {
                    verdict, count: returns.length,
                    hitRate: verdict === "HOLD" || excess.length === 0 ? null : beat.length / excess.length,
                    averageReturn: average(returns), averageExcessReturn: average(excess)
                };
            });
            return { sessions, outcomes };
        });
        return { promptVersion, analyses: rows.length, since: rows.map(({ priceDate }) => priceDate).sort()[0], horizons };
    });
};
