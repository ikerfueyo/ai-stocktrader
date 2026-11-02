import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { fetchDailyCloses } from "@/lib/server/marketData";
import { loadCorporateActions } from "@/lib/server/corporateActions";
import { cachePromise, singleton, type CacheEntry } from "@/lib/server/cache";
import { scoreVerdicts, type LoggedVerdict } from "@/lib/server/trackRecord";
import { addDays, easternParts } from "@/lib/marketHours";
import type { TickerVerdict, TrackRecord } from "@/lib/types";

const BENCHMARK = "SPY";
// compact covers about the last 100 sessions
const COMPACT_DAYS = 140;
// A verdict needs at least 5 sessions after it to be scored
const MIN_AGE_DAYS = 7;
const trackRecordCache = singleton("trackRecordCache", () => new Map<string, CacheEntry<TrackRecord>>());

// Every logged verdict old enough to score, the last one per prompt version, ticker and session, scored against the closes since
// (1 Alpha Vantage call per ticker and SPY, cached 12 hours) with those tickers' splits (fetched once for a ticker never fetched)
const buildTrackRecord = async (): Promise<TrackRecord> => {
    const today = easternParts(new Date()).dateKey;
    const { rows } = await pool.query<{ ticker: string; verdict: TickerVerdict; price_date: string; generated_at: Date; prompt_version: number }>(
        `SELECT DISTINCT ON (prompt_version, ticker, price_date) ticker, verdict, price_date::text, generated_at, prompt_version
         FROM verdict_log WHERE price_date IS NOT NULL AND price_date <= $1
         ORDER BY prompt_version, ticker, price_date, generated_at DESC`,
        [addDays(today, -MIN_AGE_DAYS)]
    );
    if (rows.length === 0) return { benchmark: BENCHMARK, versions: [], missing: [] };
    const logged: LoggedVerdict[] = rows.map(row => ({
        ticker: row.ticker, verdict: row.verdict, priceDate: row.price_date, generatedDay: easternParts(row.generated_at).dateKey, promptVersion: row.prompt_version
    }));
    const first = logged.map(({ priceDate }) => priceDate).sort()[0];
    const outputsize = first < addDays(today, -COMPACT_DAYS) ? "full" : "compact";
    const tickers = [...new Set(logged.map(({ ticker }) => ticker))];
    const missing: string[] = [];
    const [benchmarkCloses, { splits }, ...tickerCloses] = await Promise.all([
        fetchDailyCloses(BENCHMARK, outputsize).catch(() => null),
        loadCorporateActions(tickers),
        ...tickers.map(ticker => fetchDailyCloses(ticker, outputsize).catch(error => {
            console.error(`GET /api/analysis/track-record: ${ticker}: ${error.message}`);
            missing.push(ticker);
            return null;
        }))
    ]);
    const closesByTicker = Object.fromEntries(tickers.flatMap((ticker, index) => tickerCloses[index] ? [[ticker, tickerCloses[index]!]] : []));
    return { benchmark: BENCHMARK, versions: scoreVerdicts(logged, closesByTicker, benchmarkCloses, splits), missing: missing.sort() };
};

// Get how past ticker verdicts turned out, 5 and 20 sessions later, per prompt version (cached 12 hours)
export const GET = withUser(async () => NextResponse.json<TrackRecord>(await cachePromise(trackRecordCache, "trackRecord", 12 * 3600000, buildTrackRecord)));
