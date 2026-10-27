import "server-only";
import type { Pool, PoolClient } from "pg";
import pool from "./db";
import { singleton } from "./cache";
import { fetchPrices } from "./marketData";
import { isMarketOpen } from "./market";
import { loadCorporateActions } from "./corporateActions";
import { formatCurrency, planBuyIn, roundCents, valueAccount, type Dividend, type Split, type Trade } from "./account";
import { advanceTransfers } from "./broker/sim/transfers";
import { applySplits, fillsAsTrades, listFills, ledgerState, openLots, postDividends as postAccountDividends, recordFill } from "./broker/sim/positions";
import type { SimActivityRow } from "./broker/sim/shapes";
import type { CashActivityRow, FillPolicy, Position, TradeHistoryRow, TradeType } from "../types";

// The pool, or the client holding a user's account lock (withAccountLock)
export type Db = Pool | PoolClient;

// The user's account whose ledger the app reads and trades: their newest open account (one individual account each until IRAs)
export const ledgerAccountId = async (userId: string, db: Db = pool): Promise<string | null> => {
    const { rows: [row] } = await db.query<{ account_id: string }>(
        `SELECT b.account_id FROM broker_accounts b JOIN sim_accounts s ON s.id = b.account_id
         WHERE b.user_id = $1 ORDER BY (s.status IN ('REJECTED', 'ACCOUNT_CLOSED')), b.created_at DESC LIMIT 1`,
        [userId]
    );
    return row?.account_id ?? null;
};

const EMPTY_FEES = { REG: 0, TAF: 0, CAT: 0 };

// A user's account from the broker's ledger (lib/server/broker/sim/positions.ts): its fills as trades to replay (for dividends and
// the history), the traded tickers' splits and dividends (fetching any never fetched and refreshing the held tickers' once a day,
// then applying due splits to the lots, so a split is in place before the account is valued or traded; unsynced lists the tickers
// whose fetch failed), positions from the open FIFO lots, total cash (every activity's net amount: fills, deposits, withdrawals,
// fees, dividends, after advancing due transfers) less queued withdrawals (pendingTransferOut), which are held from the moment
// they're requested, realized P&L, net dividends, and what can't be withdrawn yet: instant deposit credit (unsettledInstant) and sale
// proceeds before they settle (unsettledProceeds). accruedFees are regulatory fees not yet deducted (the end of the day).
export const getAccount = async (userId: string, db: Db = pool) => {
    const accountId = await ledgerAccountId(userId, db);
    if (!accountId) {
        return {
            accountId, transactions: [] as Trade[], splits: [] as Split[], dividends: [] as Dividend[], unsynced: [] as string[], positions: [] as Position[],
            totalCash: 0, realizedPnl: 0, netDividends: 0, pendingTransferOut: 0, unsettledInstant: 0, unsettledProceeds: 0, accruedFees: EMPTY_FEES
        };
    }
    await advanceTransfers(accountId);
    const [transactions, held] = await Promise.all([fillsAsTrades(db, accountId), openLots(db, accountId)]);
    const heldTickers = [...new Set(held.map(({ symbol }) => symbol))];
    const { splits, dividends, unsynced } = await loadCorporateActions([...new Set(transactions.map(({ ticker }) => ticker.toUpperCase()))], heldTickers);
    await applySplits(db, accountId, heldTickers);
    const ledger = await ledgerState(db, accountId);
    return {
        accountId, transactions, splits, dividends, unsynced, positions: ledger.positions,
        totalCash: roundCents(ledger.cash - ledger.pendingTransferOut), realizedPnl: roundCents(ledger.realizedPnl), netDividends: roundCents(ledger.netDividends),
        pendingTransferOut: ledger.pendingTransferOut, unsettledInstant: ledger.unsettledInstant, unsettledProceeds: ledger.unsettledProceeds, accruedFees: ledger.accruedFees
    };
};

export const getPositions = async (userId: string, db: Db = pool) => (await getAccount(userId, db)).positions;

// The user's fills as trades to replay, oldest first (fillsAsTrades), for the equity history
export const getTrades = async (userId: string, db: Db = pool): Promise<Trade[]> => {
    const accountId = await ledgerAccountId(userId, db);
    return accountId ? fillsAsTrades(db, accountId) : [];
};

// A fill (a FILL activity) as the pages' TransactionRow, with the P&L it realized against the lots it closed (FIFO)
export const toTransactionRow = (row: SimActivityRow, userId: string): TradeHistoryRow => ({
    id: row.id, user_id: userId, date: row.created_at.toISOString(), type: row.side === "buy" ? "BUY" : "SELL", ticker: row.symbol ?? "",
    price: String(Number(row.price)), quantity: String(Number(row.qty)), total: Math.abs(Number(row.net_amount)).toFixed(2),
    reason: row.reason === "LIQUIDATION" ? "LIQUIDATION" : null, quote_time: row.quote_time ? row.quote_time.toISOString() : null,
    fill_policy: (row.fill_policy ?? null) as TradeHistoryRow["fill_policy"], order_id: row.legacy_order_id ?? null,
    realized_pnl: row.realized_pl === null || row.realized_pl === undefined ? null : Number(row.realized_pl), settle_date: row.settle_date ?? null
});

// The user's fills, newest first (since a time, if given)
export const getFills = async (userId: string, { since }: { since?: Date } = {}, db: Db = pool): Promise<TradeHistoryRow[]> => {
    const accountId = await ledgerAccountId(userId, db);
    return accountId ? (await listFills(db, accountId, { since })).map(row => toTransactionRow(row, userId)) : [];
};

// The user's cash ledger, oldest first, as CashActivityRows: the broker's cash activities (CSD deposits, CSW withdrawals, FEE fees,
// DIV dividends received or charged on shorts; fills are on the Trades tab)
export const loadCashActivity = async (userId: string, db: Db = pool): Promise<CashActivityRow[]> => {
    const accountId = await ledgerAccountId(userId, db);
    if (!accountId) return [];
    const { rows } = await db.query<{ id: string; activity_type: string; created_at: Date; net_amount: string; description: string; symbol: string | null }>(
        "SELECT id, activity_type, created_at, net_amount, description, symbol FROM sim_activities WHERE account_id = $1 AND activity_type IN ('CSD', 'CSW', 'FEE', 'DIV') ORDER BY created_at, id",
        [accountId]
    );
    const typeOf = (activity: string, amount: number): CashActivityRow["type"] =>
        activity === "DIV" ? (amount >= 0 ? "DIVIDEND_IN" : "DIVIDEND_OUT") : activity === "CSD" ? "DEPOSIT" : activity === "CSW" ? "WITHDRAW" : "FEE";
    return rows.map(row => ({
        id: row.id, user_id: userId, date: row.created_at.toISOString(), type: typeOf(row.activity_type, Number(row.net_amount)), method: row.description,
        amount: Math.abs(Number(row.net_amount)).toFixed(2), ticker: row.symbol, reference: null
    }));
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

// Records an executed fill in the user's account ledger (recordFill: lots, realized P&L, settlement, fee accruals), stamped now.
// orderId links the fill of a stored order (limit, stop or queued). Call it inside a transaction on withAccountLock's client.
export const insertTrade = async (db: PoolClient, userId: string, trade: {
    type: TradeType; ticker: string; price: number; quantity: number; total: number;
    fillPolicy: FillPolicy; quoteTime: string | null; reason?: "LIQUIDATION"; orderId?: number;
}): Promise<TradeHistoryRow> => {
    const accountId = await ledgerAccountId(userId, db);
    if (!accountId) throw new Error(`No brokerage account to record a ${trade.type} ${trade.ticker} fill for ${userId}`);
    const row = await recordFill(db, accountId, {
        symbol: trade.ticker, side: trade.type === "BUY" ? "buy" : "sell", qty: trade.quantity, price: trade.price, total: trade.total,
        reason: trade.reason, quoteTime: trade.quoteTime, fillPolicy: trade.fillPolicy, legacyOrderId: trade.orderId
    });
    return toTransactionRow(row, userId);
};

// Posts the dividends paid since they were last checked to the user's ledger (DIV activities; the broker's postDividends). Call it
// inside withAccountLock with its client.
export const postDividends = async (userId: string, label: string, db: PoolClient) => {
    const { accountId, splits, dividends } = await getAccount(userId, db);
    if (!accountId) return [];
    const posted = await postAccountDividends(db, accountId, { splits, dividends });
    if (posted.length > 0) {
        console.log(`${label}: posted ${posted.length} dividend${posted.length === 1 ? "" : "s"} for ${userId}: ${posted.map(({ symbol, net_amount }) => `${symbol} ${net_amount}`).join(", ")}`);
    }
    return posted;
};

export const shortTickers = (positions: Position[]) => positions.filter(({ quantity }) => quantity < 0).map(({ ticker }) => ticker);

// Automatic buy-in (see planBuyIn): when total cash is below 130% of the shorts' value, cover just enough of every short to get back
// to 150%, and sell longs only if covering every short leaves negative cash. The trades are marked reason = 'LIQUIDATION'.
// Prices only arrive with requests, so this runs lazily, from GET /api/account, GET /api/portfolio and after each trade, and only
// while the market is open (prices don't move while it's closed, and there's no market to buy in on). Call it inside
// withAccountLock with its client. It's recalculated from the database each time, so running it again right away does nothing.
// It waits while any position's splits couldn't be fetched, since a missed split would misstate the shares owed and the cash needed.
export const enforceCollateral = async (userId: string, label: string, db: PoolClient): Promise<TradeHistoryRow[]> => {
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
        const rows: TradeHistoryRow[] = [];
        for (const { type, ticker, price, quantity, total, fillPolicy } of trades) {
            rows.push(await insertTrade(db, userId, { type, ticker, price, quantity, total, fillPolicy, quoteTime: quotes[ticker]?.quoteTime ?? null, reason: "LIQUIDATION" }));
        }
        return rows;
    });
    const summary = inserted.map(({ type, ticker, quantity, price }) => `${type} ${parseFloat(quantity)} ${ticker} @ ${price}`).join(", ");
    console.log(`${label}: collateral buy-in for ${userId}: ${summary}${remainingDeficit > 0 ? `; ${formatCurrency(remainingDeficit)} still negative` : ""}`);
    return inserted;
};
