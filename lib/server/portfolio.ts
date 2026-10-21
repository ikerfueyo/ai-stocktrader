import "server-only";
import type { Pool, PoolClient } from "pg";
import pool from "./db";
import { singleton } from "./cache";
import { fetchPrices } from "./alphaVantage";
import { isMarketOpen } from "./market";
import { computePositions, formatCurrency, planBuyIn, roundCents, valueAccount } from "./account";
import type { FillPolicy, Position, TradeType, TransactionRow } from "../types";

// The pool, or the client holding a user's account lock (withAccountLock)
export type Db = Pool | PoolClient;

export const getPositions = async (userId: string, ticker?: string, db: Db = pool) => {
    const { rows } = ticker
        ? await db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 AND UPPER(ticker) = $2 ORDER BY "date", id', [userId, ticker])
        : await db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]);
    return computePositions(rows).positions;
};

// A user's trade history, open positions and total cash (the trades' cash ledger plus net deposits). A client runs its queries
// one at a time, so they're only parallel on the pool.
export const getAccount = async (userId: string, db: Db = pool) => {
    const [{ rows: transactions }, { rows: [{ net }] }] = await Promise.all([
        db.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]),
        db.query<{ net: string }>(`SELECT COALESCE(SUM(CASE "type" WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0) AS net FROM cash_transfers WHERE user_id = $1`, [userId])
    ]);
    const netTransfers = parseFloat(net);
    const { positions, cash } = computePositions(transactions);
    return { transactions, netTransfers, positions, totalCash: roundCents(cash + netTransfers) };
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

// Inserts an executed trade, stamped now
export const insertTrade = async (db: Db, userId: string, trade: {
    type: TradeType; ticker: string; price: number; quantity: number; total: number;
    fillPolicy: FillPolicy; quoteTime: string | null; reason?: "LIQUIDATION";
}): Promise<TransactionRow> => {
    const { rows } = await db.query<TransactionRow>(
        `INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total, reason, quote_time, fill_policy)
         VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [userId, trade.type, trade.ticker, trade.price, trade.quantity, trade.total, trade.reason ?? null, trade.quoteTime, trade.fillPolicy]
    );
    return rows[0];
};

export const shortTickers = (positions: Position[]) => positions.filter(({ quantity }) => quantity < 0).map(({ ticker }) => ticker);

// Automatic buy-in (see planBuyIn): when total cash is below 130% of the shorts' value, cover just enough of every short to get back
// to 150%, and sell longs only if covering every short leaves negative cash. The trades are marked reason = 'LIQUIDATION'.
// Prices only arrive with requests, so this runs lazily, from GET /api/account, GET /api/portfolio and after each trade, and only
// while the market is open (prices don't move while it's closed, and there's no market to buy in on). Call it inside
// withAccountLock with its client. It's recalculated from the database each time, so running it again right away does nothing.
export const enforceCollateral = async (userId: string, label: string, db: PoolClient): Promise<TransactionRow[]> => {
    const { positions, totalCash } = await getAccount(userId, db);
    const shorts = shortTickers(positions);
    if (shorts.length === 0 || !(await isMarketOpen())) return [];
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
