import "server-only";
import pool from "./db";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { fetchAlpacaCorporateActions, fetchCorporateActions, isAlpacaConfigured } from "./marketData";
import type { Dividend, Split } from "./account";

// Corporate actions are stored in Postgres (corporate_actions, shared by all users), fetched once per ticker and refreshed daily while
// the ticker is held: splits and cash dividends from Alpha Vantage, and with Alpaca keys the stock dividends, mergers, spinoffs,
// symbol changes and worthless removals Alpha Vantage doesn't have (Alpaca's corporate actions API). A ticker that's no longer held
// keeps what was stored, which covers everything up to its last trade.
const REFRESH_MS = 24 * 3600000;
const syncs = singleton("corporateActionSyncs", () => new Map<string, CacheEntry<void>>());

// Fetches and stores a ticker's corporate actions (2 Alpha Vantage calls, and 1 Alpaca call with keys; Alpaca's failing is only
// logged). Concurrent requests for a ticker share one sync.
const syncTicker = (ticker: string) => cachePromise(syncs, ticker, 60000, async () => {
    const [{ splits, dividends }, others] = await Promise.all([
        fetchCorporateActions(ticker),
        isAlpacaConfigured()
            ? fetchAlpacaCorporateActions(ticker).catch(error => {
                console.error(`Corporate actions for ${ticker} from Alpaca: ${error.message}`);
                return [];
            })
            : []
    ]);
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
        for (const { ticker: symbol, type, exDate, paymentDate, factor, amount, newTicker } of others) {
            await client.query(
                `INSERT INTO corporate_actions (ticker, "type", ex_date, payment_date, factor, amount, new_ticker, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'alpaca')
                 ON CONFLICT (ticker, "type", ex_date) DO UPDATE SET payment_date = EXCLUDED.payment_date, factor = EXCLUDED.factor, amount = EXCLUDED.amount,
                     new_ticker = EXCLUDED.new_ticker`,
                [symbol, type, exDate, paymentDate, factor, amount, newTicker]
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

// The stored splits and cash dividends of these tickers (the other actions are applied to accounts by the broker). Tickers never fetched are fetched first, and so are refreshTickers (the open
// positions) checked more than a day ago, so a split is in place before the account is valued or traded. A failure is logged and
// the ticker listed in unsynced (replayed with what's stored, possibly nothing) until a later request succeeds.
export const loadCorporateActions = async (tickers: string[], refreshTickers: string[] = []): Promise<{ splits: Split[]; dividends: Dividend[]; unsynced: string[] }> => {
    if (tickers.length === 0) return { splits: [], dividends: [], unsynced: [] };
    const { rows: checked } = await pool.query<{ ticker: string; checked_at: Date }>(
        "SELECT ticker, checked_at FROM corporate_actions_checked WHERE ticker = ANY($1)", [tickers]
    );
    const checkedAt = new Map(checked.map(({ ticker, checked_at }) => [ticker, checked_at.getTime()]));
    const due = [
        ...tickers.filter(ticker => !checkedAt.has(ticker)),
        ...refreshTickers.filter(ticker => (checkedAt.get(ticker) ?? Infinity) < Date.now() - REFRESH_MS)
    ];
    const results = await Promise.allSettled(due.map(syncTicker));
    const unsynced: string[] = [];
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        console.error(`Corporate actions for ${due[index]}: ${result.reason.message}`);
        unsynced.push(due[index]);
    });
    // Dates as text: pg would turn a DATE into a Date at the server's local midnight
    const { rows } = await pool.query<{ ticker: string; type: "SPLIT" | "DIVIDEND"; ex_date: string; payment_date: string | null; factor: string | null; amount: string | null }>(
        `SELECT ticker, "type", ex_date::text, payment_date::text, factor, amount FROM corporate_actions WHERE ticker = ANY($1) AND "type" IN ('SPLIT', 'DIVIDEND') ORDER BY ex_date`, [tickers]
    );
    return {
        unsynced,
        splits: rows.filter(row => row.type === "SPLIT").map(row => ({ ticker: row.ticker, exDate: row.ex_date, factor: parseFloat(row.factor!) })),
        dividends: rows.filter(row => row.type === "DIVIDEND").map(row => ({
            ticker: row.ticker, exDate: row.ex_date, paymentDate: row.payment_date, amount: parseFloat(row.amount!)
        }))
    };
};
