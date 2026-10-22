import "server-only";
import pool from "./db";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { fetchCorporateActions } from "./alphaVantage";
import type { Dividend, Split } from "./account";

// Splits and dividends are stored in Postgres (corporate_actions, shared by all users), fetched from Alpha Vantage once per ticker and
// refreshed daily while the ticker is held. A ticker that's no longer held keeps what was stored, which covers everything up to its
// last trade.
const REFRESH_MS = 24 * 3600000;
const syncs = singleton("corporateActionSyncs", () => new Map<string, CacheEntry<void>>());

// Fetches and stores a ticker's splits and dividends (2 Alpha Vantage calls). Concurrent requests for a ticker share one sync.
const syncTicker = (ticker: string) => cachePromise(syncs, ticker, 60000, async () => {
    const { splits, dividends } = await fetchCorporateActions(ticker);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (const { exDate, factor } of splits) {
            await client.query(
                `INSERT INTO corporate_actions (ticker, "type", ex_date, factor) VALUES ($1, 'SPLIT', $2, $3)
                 ON CONFLICT (ticker, "type", ex_date) DO UPDATE SET factor = EXCLUDED.factor`,
                [ticker, exDate, factor]
            );
        }
        for (const { exDate, paymentDate, amount } of dividends) {
            await client.query(
                `INSERT INTO corporate_actions (ticker, "type", ex_date, payment_date, amount) VALUES ($1, 'DIVIDEND', $2, $3, $4)
                 ON CONFLICT (ticker, "type", ex_date) DO UPDATE SET payment_date = EXCLUDED.payment_date, amount = EXCLUDED.amount`,
                [ticker, exDate, paymentDate, amount]
            );
        }
        await client.query(
            `INSERT INTO corporate_actions_checked (ticker, checked_at) VALUES ($1, now()) ON CONFLICT (ticker) DO UPDATE SET checked_at = now()`,
            [ticker]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

// The stored splits and dividends of these tickers. Tickers never fetched are fetched first (a failure is logged, and the ticker
// is replayed without corporate actions until a later request succeeds); refreshTickers (the open positions) checked more than a
// day ago are refreshed in the background, so the next request sees any new ones.
export const loadCorporateActions = async (tickers: string[], refreshTickers: string[] = []): Promise<{ splits: Split[]; dividends: Dividend[] }> => {
    if (tickers.length === 0) return { splits: [], dividends: [] };
    const { rows: checked } = await pool.query<{ ticker: string; checked_at: Date }>(
        "SELECT ticker, checked_at FROM corporate_actions_checked WHERE ticker = ANY($1)", [tickers]
    );
    const checkedAt = new Map(checked.map(({ ticker, checked_at }) => [ticker, checked_at.getTime()]));
    const missing = tickers.filter(ticker => !checkedAt.has(ticker));
    for (const ticker of refreshTickers.filter(ticker => (checkedAt.get(ticker) ?? Infinity) < Date.now() - REFRESH_MS)) {
        syncTicker(ticker).catch(error => console.error(`Corporate actions for ${ticker}: ${error.message}`));
    }
    const results = await Promise.allSettled(missing.map(syncTicker));
    results.forEach((result, index) => {
        if (result.status === "rejected") console.error(`Corporate actions for ${missing[index]}: ${result.reason.message}`);
    });
    // Dates as text: pg would turn a DATE into a Date at the server's local midnight
    const { rows } = await pool.query<{ ticker: string; type: "SPLIT" | "DIVIDEND"; ex_date: string; payment_date: string | null; factor: string | null; amount: string | null }>(
        'SELECT ticker, "type", ex_date::text, payment_date::text, factor, amount FROM corporate_actions WHERE ticker = ANY($1) ORDER BY ex_date', [tickers]
    );
    return {
        splits: rows.filter(row => row.type === "SPLIT").map(row => ({ ticker: row.ticker, exDate: row.ex_date, factor: parseFloat(row.factor!) })),
        dividends: rows.filter(row => row.type === "DIVIDEND").map(row => ({
            ticker: row.ticker, exDate: row.ex_date, paymentDate: row.payment_date, amount: parseFloat(row.amount!)
        }))
    };
};
