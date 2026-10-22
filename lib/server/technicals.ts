// Price and technical figures for the AI analysis, computed here from daily closes rather than left to the model. Pure, so they
// can be unit tested.

export interface Technicals {
    // The newest bar's date and close
    asOf: string;
    price: number;
    // Returns over the last 5, 21 and 63 sessions (about a week, a month and three months), as fractions; null without enough bars
    return5d: number | null;
    return1m: number | null;
    return3m: number | null;
    // How far the price is above (positive) or below its 50- and 200-session simple moving averages, as fractions
    vsSma50: number | null;
    vsSma200: number | null;
    // 14-session RSI (Wilder's smoothing), 0 to 100
    rsi14: number | null;
    // The 21- and 63-session returns less the benchmark's (SPY) between the same dates; null without its closes
    vsBenchmark1m: number | null;
    vsBenchmark3m: number | null;
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// Wilder's RSI over the closes (oldest first): seeded with the first period's average gain and loss, then smoothed
export const rsi = (closes: number[], period = 14): number | null => {
    if (closes.length <= period) return null;
    const changes = closes.slice(1).map((close, i) => close - closes[i]);
    let gain = average(changes.slice(0, period).map(change => Math.max(change, 0)));
    let loss = average(changes.slice(0, period).map(change => Math.max(-change, 0)));
    for (const change of changes.slice(period)) {
        gain = (gain * (period - 1) + Math.max(change, 0)) / period;
        loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    }
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
};

// The benchmark's newest close on or before a date (its dates sorted), so a benchmark series a day behind still lines up
const closeOnOrBefore = (closesByDate: Record<string, number>, dates: string[], date: string) => {
    for (let i = dates.length - 1; i >= 0; i--) {
        if (dates[i] <= date) return closesByDate[dates[i]];
    }
    return null;
};

// The figures from closes by date ("YYYY-MM-DD"), or null without any, with the returns compared to the benchmark's closes if given
export const computeTechnicals = (closesByDate: Record<string, number>, benchmarkCloses: Record<string, number> | null = null): Technicals | null => {
    const dates = Object.keys(closesByDate).sort();
    if (dates.length === 0) return null;
    const closes = dates.map(date => closesByDate[date]);
    const price = closes.at(-1)!;
    const back = (sessions: number) => closes.length > sessions ? price / closes[closes.length - 1 - sessions] - 1 : null;
    const vsSma = (sessions: number) => closes.length >= sessions ? price / average(closes.slice(-sessions)) - 1 : null;
    const benchmarkDates = benchmarkCloses ? Object.keys(benchmarkCloses).sort() : [];
    const vsBenchmark = (sessions: number) => {
        const stockReturn = back(sessions);
        if (stockReturn === null || !benchmarkCloses) return null;
        const start = closeOnOrBefore(benchmarkCloses, benchmarkDates, dates[dates.length - 1 - sessions]);
        const end = closeOnOrBefore(benchmarkCloses, benchmarkDates, dates.at(-1)!);
        return start && end ? stockReturn - (end / start - 1) : null;
    };
    return {
        asOf: dates.at(-1)!, price,
        return5d: back(5), return1m: back(21), return3m: back(63),
        vsSma50: vsSma(50), vsSma200: vsSma(200),
        rsi14: rsi(closes),
        vsBenchmark1m: vsBenchmark(21), vsBenchmark3m: vsBenchmark(63)
    };
};
