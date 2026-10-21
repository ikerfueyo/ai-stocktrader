import "server-only";
import pool from "./db";
import { singleton } from "./cache";
import { fetchPrices } from "./alphaVantage";
import { computePositions, formatCurrency, planBuyIn, roundCents, valueAccount } from "./account";
import type { Position, TransactionRow } from "../types";

export const getPositions = async (userId: string, ticker?: string) => {
    const { rows } = ticker
        ? await pool.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 AND UPPER(ticker) = $2 ORDER BY "date", id', [userId, ticker])
        : await pool.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]);
    return computePositions(rows).positions;
};

// A user's trade history, open positions and total cash (the trades' cash ledger plus net deposits)
export const getAccount = async (userId: string) => {
    const [{ rows: transactions }, { rows: [{ net }] }] = await Promise.all([
        pool.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]),
        pool.query<{ net: string }>(`SELECT COALESCE(SUM(CASE "type" WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0) AS net FROM cash_transfers WHERE user_id = $1`, [userId])
    ]);
    const netTransfers = parseFloat(net);
    const { positions, cash } = computePositions(transactions);
    return { transactions, netTransfers, positions, totalCash: roundCents(cash + netTransfers) };
};

// Serializes each user's account changes (collateral checks, buy-ins, trades and withdrawals), so a check can't pass on cash that
// another request is about to spend. Users don't wait on each other. It's an in-process queue, so it assumes a single server process.
const accountQueues = singleton("accountQueues", () => new Map<string, Promise<unknown>>());
export const withAccountLock = <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (accountQueues.get(userId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    accountQueues.set(userId, tail);
    // Forget the queue once nothing else has joined it
    tail.then(() => {
        if (accountQueues.get(userId) === tail) accountQueues.delete(userId);
    });
    return run;
};

export const shortTickers = (positions: Position[]) => positions.filter(({ quantity }) => quantity < 0).map(({ ticker }) => ticker);

// Automatic buy-in (see planBuyIn): when total cash is below 130% of the shorts' value, cover just enough of every short to get back
// to 150%, and sell longs only if covering every short leaves negative cash. The trades are marked reason = 'LIQUIDATION'.
// Prices only arrive with requests, so this runs lazily, from GET /api/account, GET /api/portfolio and after each trade. Call it
// inside withAccountLock. It's recalculated from the database each time, so running it again right away does nothing.
export const enforceCollateral = async (userId: string, label: string): Promise<TransactionRow[]> => {
    const { positions, totalCash } = await getAccount(userId);
    const shorts = shortTickers(positions);
    if (shorts.length === 0) return [];
    const shortPrices = await fetchPrices(shorts, label);
    if (valueAccount({ positions, totalCash, ...shortPrices }).marginStatus !== "buy_in") return [];
    // Longs are only priced when a buy-in is due, in case covering every short isn't enough
    const longPrices = await fetchPrices(positions.filter(({ quantity }) => quantity > 0).map(({ ticker }) => ticker), label);
    const { trades, remainingDeficit } = planBuyIn({
        positions, totalCash,
        prices: { ...longPrices.prices, ...shortPrices.prices },
        staleTickers: [...longPrices.staleTickers, ...shortPrices.staleTickers]
    });
    if (trades.length === 0) return [];
    const client = await pool.connect();
    const inserted: TransactionRow[] = [];
    try {
        await client.query("BEGIN");
        for (const { type, ticker, price, quantity, total } of trades) {
            const { rows } = await client.query<TransactionRow>(
                `INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total, reason) VALUES($1, now(), $2, $3, $4, $5, $6, 'LIQUIDATION') RETURNING *`,
                [userId, type, ticker, price, quantity, total]
            );
            inserted.push(rows[0]);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    const summary = inserted.map(({ type, ticker, quantity, price }) => `${type} ${parseFloat(quantity)} ${ticker} @ ${price}`).join(", ");
    console.log(`${label}: collateral buy-in for ${userId}: ${summary}${remainingDeficit > 0 ? `; ${formatCurrency(remainingDeficit)} still negative` : ""}`);
    return inserted;
};
