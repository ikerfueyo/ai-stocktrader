import "server-only";
import { isOptionSymbol } from "../options";
import pool from "./db";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { fetchAlpacaCorporateActions, fetchCorporateActions, fetchDailySeries, isAlpacaConfigured, priceOverride } from "./marketData";
import { addDays, easternParts } from "../marketHours";
import type { CorporateAction, CorporateActionType } from "./broker/sim/corporateActions";
import type { ShareAction } from "./brokerLedger";
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
export const loadCorporateActions = async (allTickers: string[], allRefreshTickers: string[] = []): Promise<{ splits: Split[]; dividends: Dividend[]; unsynced: string[] }> => {
    // Option contracts have no corporate actions of their own (an adjusted contract is a new, non-standard one, which isn't offered)
    const tickers = allTickers.filter(ticker => !isOptionSymbol(ticker));
    const refreshTickers = allRefreshTickers.filter(ticker => !isOptionSymbol(ticker));
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

// A symbol's close on a past day (PRICE_OVERRIDES' price when it has one), from its daily series (the full one for a day more than
// about 100 sessions back), or null when there's none. Kept 12 hours, as a finished day's close doesn't change (the simulator's
// true-up fetches its own afresh, since it can run on the day itself).
const closes = singleton("effectiveDateCloses", () => new Map<string, CacheEntry<number | null>>());
const closeOn = (symbol: string, day: string): Promise<number | null> => {
    const override = priceOverride(symbol);
    if (override !== undefined) return Promise.resolve(override);
    // A failed fetch isn't kept, so it's tried again on the next read
    return cachePromise(closes, `${symbol}|${day}`, 12 * 3600000, async () => {
        const size = day < addDays(easternParts(new Date()).dateKey, -140) ? "full" : "compact";
        const bar = (await fetchDailySeries(symbol, size))["Time Series (Daily)"]?.[day];
        const close = bar ? parseFloat(bar["4. close"]) : NaN;
        return close > 0 ? close : null;
    }).catch(() => null);
};

// The stored share-changing actions (not splits or cash dividends) of these tickers that have taken effect, oldest first, with the
// effective date's closes a spinoff or mixed merger allocates basis by, following each to the symbol it leads to (an acquirer, a
// spun-off company, a new symbol), for replaying an account's lots without the simulator's (lib/server/brokerLedger.ts).
// loadCorporateActions has fetched the tickers first.
export const loadShareActions = async (allTickers: string[], today = easternParts(new Date()).dateKey): Promise<ShareAction[]> => {
    const queue = [...new Set(allTickers.filter(ticker => !isOptionSymbol(ticker)).map(ticker => ticker.toUpperCase()))];
    const seen = new Set(queue);
    const actions: ShareAction[] = [];
    while (queue.length > 0) {
        const { rows } = await pool.query<{ ticker: string; type: CorporateActionType; ex_date: string; factor: string | null; amount: string | null; new_ticker: string | null; taxable: boolean | null }>(
            `SELECT ticker, "type", ex_date::text, factor, amount, new_ticker, taxable FROM corporate_actions
             WHERE ticker = ANY($1) AND "type" NOT IN ('SPLIT', 'DIVIDEND') AND ex_date <= $2 ORDER BY ex_date, ticker`, [queue.splice(0, queue.length), today]
        );
        for (const row of rows) {
            const action: CorporateAction = {
                type: row.type, symbol: row.ticker, newSymbol: row.new_ticker, factor: row.factor === null ? null : Number(row.factor), cash: row.amount === null ? null : Number(row.amount),
                exDate: row.ex_date, taxable: row.taxable
            };
            const [own, other] = await Promise.all([
                row.type === "SPINOFF" ? closeOn(row.ticker, row.ex_date) : Promise.resolve(null),
                (row.type === "SPINOFF" || row.type === "MIXED_MERGER") && row.new_ticker ? closeOn(row.new_ticker, row.ex_date) : Promise.resolve(null)
            ]);
            actions.push({ action, prices: { symbol: own, newSymbol: other } });
            if (row.new_ticker && !seen.has(row.new_ticker)) {
                seen.add(row.new_ticker);
                queue.push(row.new_ticker);
            }
        }
    }
    return actions.sort((a, b) => a.action.exDate.localeCompare(b.action.exDate) || a.action.symbol.localeCompare(b.action.symbol));
};
