import "server-only";
import type { Pool, PoolClient } from "pg";
import pool from "./db";
import { singleton } from "./cache";
import { fetchPrices } from "./marketData";
import { isMarketOpen } from "./market";
import { loadCorporateActions } from "./corporateActions";
import { computePositions, formatCurrency, planBuyIn, planDividends, roundCents, valueAccount } from "./account";
import { easternTime } from "../marketHours";
import type { CashActivityRow, FillPolicy, Position, TradeType, TransactionRow } from "../types";

// The pool, or the client holding a user's account lock (withAccountLock)
export type Db = Pool | PoolClient;

const tradedTickers = (transactions: TransactionRow[]) => [...new Set(transactions.map(({ ticker }) => ticker.toUpperCase()))];

// Replays trades with the tickers' stored splits, fetching any never fetched and refreshing the open positions' once a day first;
// unsynced lists the tickers whose fetch failed
const replay = async (transactions: TransactionRow[]) => {
    const tickers = tradedTickers(transactions);
    const naive = computePositions(transactions).positions.map(({ ticker }) => ticker);
    const { splits, dividends, unsynced } = await loadCorporateActions(tickers, naive);
    return { splits, dividends, unsynced, ...computePositions(transactions, splits) };
};

export const getPositions = async (userId: string, ticker?: string, db: Db = pool) => {
    const { rows } = ticker
        ? await db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 AND UPPER(ticker) = $2 ORDER BY "date", id', [userId, ticker])
        : await db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]);
    return (await replay(rows)).positions;
};

// A user's trade history, the traded tickers' splits and dividends, open positions (split-adjusted), total cash (the trades'
// cash ledger plus net cash activity: deposits and dividends received, less withdrawals and dividends paid on shorts), realized P&L
// (in total and per transaction, by index) and net dividends. A client runs
// its queries one at a time, so they're only parallel on the pool.
export const getAccount = async (userId: string, db: Db = pool) => {
    const [{ rows: transactions }, { rows: [{ net, dividends: netDividends }] }] = await Promise.all([
        db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]),
        db.query<{ net: string; dividends: string }>(
            `SELECT COALESCE(SUM(CASE WHEN "type" IN ('DEPOSIT', 'DIVIDEND_IN') THEN amount ELSE -amount END), 0) AS net,
                    COALESCE(SUM(CASE "type" WHEN 'DIVIDEND_IN' THEN amount WHEN 'DIVIDEND_OUT' THEN -amount ELSE 0 END), 0) AS dividends
             FROM cash_activity WHERE user_id = $1`,
            [userId]
        )
    ]);
    const netTransfers = parseFloat(net);
    const { positions, cash, splits, dividends, unsynced, realizedPnl, realized } = await replay(transactions);
    return {
        transactions, splits, dividends, unsynced, netTransfers, positions, totalCash: roundCents(cash + netTransfers),
        realizedPnl, realized, netDividends: parseFloat(netDividends)
    };
};

// Runs fn in a database transaction on db, which must be a client (such as withAccountLock's)
export const inTransaction = async <T>(client: PoolClient, fn: () => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
};

// Serializes each user's account changes (collateral checks, buy-ins, trades and withdrawals), so a check can't pass on cash that
// another request is about to spend. Users don't wait on each other. fn gets a client holding a Postgres advisory lock on the user,
// so this holds across server processes too; the in-process queue in front of it keeps one process's requests from each tying up a
// pool connection while they wait.
const accountQueues = singleton("accountQueues", () => new Map<string, Promise<unknown>>());
const lockedRun = async <T>(userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [userId]);
        try {
            return await fn(client);
        } finally {
            await client.query("SELECT pg_advisory_unlock(hashtext($1))", [userId]).catch(error => {
                // Closing the connection releases the lock
                broken = error;
            });
        }
    } finally {
        client.release(broken);
    }
};
export const withAccountLock = <T>(userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> => {
    const locked = () => lockedRun(userId, fn);
    const run = (accountQueues.get(userId) ?? Promise.resolve()).then(locked, locked);
    const tail = run.catch(() => {});
    accountQueues.set(userId, tail);
    // Forget the queue once nothing else has joined it
    tail.then(() => {
        if (accountQueues.get(userId) === tail) accountQueues.delete(userId);
    });
    return run;
};

// Inserts an executed trade, stamped now. orderId links the fill of a stored order (limit, stop or queued). The last guard against
// a bad fill: the price and quantity must be positive and the total not negative.
export const insertTrade = async (db: Db, userId: string, trade: {
    type: TradeType; ticker: string; price: number; quantity: number; total: number;
    fillPolicy: FillPolicy; quoteTime: string | null; reason?: "LIQUIDATION"; orderId?: number;
}): Promise<TransactionRow> => {
    const isPositive = (value: number) => Number.isFinite(value) && value > 0;
    if (!isPositive(trade.price) || !isPositive(trade.quantity) || !(Number.isFinite(trade.total) && trade.total >= 0)) {
        throw new Error(`Refusing an invalid ${trade.type} ${trade.ticker} fill: ${trade.quantity} @ ${trade.price}, total ${trade.total}`);
    }
    const { rows } = await db.query<TransactionRow>(
        `INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total, reason, quote_time, fill_policy, order_id)
         VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [userId, trade.type, trade.ticker, trade.price, trade.quantity, trade.total, trade.reason ?? null, trade.quoteTime, trade.fillPolicy, trade.orderId ?? null]
    );
    return rows[0];
};

// cash_activity's columns, with the reference date as text (pg would turn a DATE into a Date at the server's local midnight)
export const CASH_ACTIVITY_COLUMNS = 'id, user_id, "date", "type", method, amount, ticker, reference::text AS reference';

// Posts the dividends that have been paid since they were last checked (planDividends) to cash_activity: received on longs,
// charged to shorts, dated at the payment date's close (or now, if that's later today). The unique index makes a repeat a no-op.
// Call it inside withAccountLock with its client.
export const postDividends = async (userId: string, label: string, db: PoolClient): Promise<CashActivityRow[]> => {
    const { transactions, splits, dividends } = await getAccount(userId, db);
    const { rows: postedRows } = await db.query<{ ticker: string; reference: string }>(
        `SELECT ticker, reference::text FROM cash_activity WHERE user_id = $1 AND "type" IN ('DIVIDEND_IN', 'DIVIDEND_OUT')`, [userId]
    );
    const posted = new Set(postedRows.map(({ ticker, reference }) => `${ticker}|${reference}`));
    const postings = planDividends({ transactions, splits, dividends, posted });
    const inserted: CashActivityRow[] = [];
    for (const { type, ticker, exDate, shares, perShare, total } of postings) {
        const payment = dividends.find(dividend => dividend.ticker === ticker && dividend.exDate === exDate)?.paymentDate ?? exDate;
        const paidAt = new Date(Math.min(easternTime(payment, "16:00").getTime(), Date.now()));
        const method = `${ticker} dividend: ${parseFloat(shares.toFixed(6))} ${type === "DIVIDEND_IN" ? "shares" : "shares short"} × $${perShare}`;
        const { rows } = await db.query<CashActivityRow>(
            `INSERT INTO cash_activity (user_id, "date", "type", method, amount, ticker, reference) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, ticker, reference) WHERE "type" IN ('DIVIDEND_IN', 'DIVIDEND_OUT') DO NOTHING RETURNING ${CASH_ACTIVITY_COLUMNS}`,
            [userId, paidAt, type, method.slice(0, 255), total, ticker, exDate]
        );
        inserted.push(...rows);
    }
    if (inserted.length > 0) {
        console.log(`${label}: posted ${inserted.length} dividend${inserted.length === 1 ? "" : "s"} for ${userId}: ${inserted.map(({ type, ticker, amount }) => `${type} ${ticker} ${amount}`).join(", ")}`);
    }
    return inserted;
};

export const shortTickers = (positions: Position[]) => positions.filter(({ quantity }) => quantity < 0).map(({ ticker }) => ticker);

// Automatic buy-in (see planBuyIn): when total cash is below 130% of the shorts' value, cover just enough of every short to get back
// to 150%, and sell longs only if covering every short leaves negative cash. The trades are marked reason = 'LIQUIDATION'.
// Prices only arrive with requests, so this runs lazily, from GET /api/account, GET /api/portfolio and after each trade, and only
// while the market is open (prices don't move while it's closed, and there's no market to buy in on). Call it inside
// withAccountLock with its client. It's recalculated from the database each time, so running it again right away does nothing.
// It waits while any position's splits couldn't be fetched, since a missed split would misstate the shares owed and the cash needed.
export const enforceCollateral = async (userId: string, label: string, db: PoolClient): Promise<TransactionRow[]> => {
    const { positions, totalCash, unsynced } = await getAccount(userId, db);
    const shorts = shortTickers(positions);
    if (shorts.length === 0 || !(await isMarketOpen())) return [];
    const unsure = positions.filter(({ ticker }) => unsynced.includes(ticker)).map(({ ticker }) => ticker);
    if (unsure.length > 0) {
        console.warn(`${label}: buy-in check for ${userId} skipped until ${unsure.join(", ")} corporate actions can be fetched`);
        return [];
    }
    const shortPrices = await fetchPrices(shorts, label);
    if (valueAccount({ positions, totalCash, ...shortPrices }).marginStatus !== "buy_in") return [];
    // Longs are only priced when a buy-in is due, in case covering every short isn't enough
    const longPrices = await fetchPrices(positions.filter(({ quantity }) => quantity > 0).map(({ ticker }) => ticker), label);
    const quotes = { ...longPrices.quotes, ...shortPrices.quotes };
    const { trades, remainingDeficit } = planBuyIn({
        positions, totalCash,
        prices: { ...longPrices.prices, ...shortPrices.prices },
        staleTickers: [...longPrices.staleTickers, ...shortPrices.staleTickers],
        quotes
    });
    if (trades.length === 0) return [];
    const inserted = await inTransaction(db, async () => {
        const rows: TransactionRow[] = [];
        for (const { type, ticker, price, quantity, total, fillPolicy } of trades) {
            rows.push(await insertTrade(db, userId, { type, ticker, price, quantity, total, fillPolicy, quoteTime: quotes[ticker]?.quoteTime ?? null, reason: "LIQUIDATION" }));
        }
        return rows;
    });
    const summary = inserted.map(({ type, ticker, quantity, price }) => `${type} ${parseFloat(quantity)} ${ticker} @ ${price}`).join(", ");
    console.log(`${label}: collateral buy-in for ${userId}: ${summary}${remainingDeficit > 0 ? `; ${formatCurrency(remainingDeficit)} still negative` : ""}`);
    return inserted;
};
