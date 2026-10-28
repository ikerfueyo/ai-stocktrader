import "server-only";
import type { Pool, PoolClient } from "pg";
import pool from "./db";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { requestContext } from "./requestContext";
import { loadCorporateActions } from "./corporateActions";
import { roundCents, type Dividend, type Split, type Trade } from "./account";
import { advanceTransfers } from "./broker/sim/transfers";
import { enforceMargin as enforceAccountMargin } from "./broker/sim/calls";
import { applyCorporateActions, fillsAsTrades, listFills, ledgerState, openLots, postDividends as postAccountDividends } from "./broker/sim/positions";
import type { SimActivityRow } from "./broker/sim/shapes";
import { orderReasons } from "./broker/sim/orders";
import { brokerMode, getBroker } from "./broker";
import { CASH_ACTIVITY_TYPES, cashRowsOf, ledgerOf, listAllActivities, transactionRowsOf, tradesOf } from "./brokerLedger";
import type { Order as BrokerOrder } from "./broker/types";
import type { CashActivityRow, Position, TradeHistoryRow } from "../types";

// The pool, or the client holding a user's account lock (withAccountLock)
export type Db = Pool | PoolClient;

// With the simulator, the app reads its ledger directly (lib/server/broker/sim); with Alpaca, everything comes through the Broker
// interface (lib/server/brokerLedger.ts). For testing, BROKER_LEDGER=broker reads the simulator that way too, as the app reads Alpaca.
export const readsThroughBroker = () => brokerMode() !== "sim" || process.env.BROKER_LEDGER === "broker";
const throughBroker = readsThroughBroker;

// Alpaca accounts' statuses, kept 30 seconds (every request resolves its account)
const statusCache = singleton("brokerAccountStatuses", () => new Map<string, CacheEntry<string>>());
const CLOSED = ["REJECTED", "ACCOUNT_CLOSED"];

// The user's accounts at the broker in use, newest first with closed and rejected ones last, and whether each is open
const userAccounts = async (userId: string, db: Db): Promise<{ account_id: string; open: boolean }[]> => {
    if (!throughBroker()) {
        return (await db.query<{ account_id: string; open: boolean }>(
            `SELECT b.account_id, s.status NOT IN ('REJECTED', 'ACCOUNT_CLOSED') AS open FROM broker_accounts b JOIN sim_accounts s ON s.id = b.account_id
             WHERE b.user_id = $1 ORDER BY (s.status IN ('REJECTED', 'ACCOUNT_CLOSED')), b.created_at DESC`,
            [userId]
        )).rows;
    }
    const { rows } = await db.query<{ account_id: string }>("SELECT account_id FROM broker_accounts WHERE user_id = $1 AND broker = $2 ORDER BY created_at DESC", [userId, brokerMode()]);
    const statuses = await Promise.all(rows.map(({ account_id }) => cachePromise(statusCache, account_id, 30000, async () => (await getBroker().getAccount(account_id)).status)));
    const accounts = rows.map(({ account_id }, index) => ({ account_id, open: !CLOSED.includes(statuses[index]) }));
    return [...accounts.filter(({ open }) => open), ...accounts.filter(({ open }) => !open)];
};

// The user's account whose ledger the app reads and trades: the one a background job is working on (withLedgerAccount), else the
// request's active account (the account switcher's cookie) when it's the user's and open, else their newest open account (else their
// newest). A user can hold an individual account and an IRA of each kind.
export const ledgerAccountId = async (userId: string, db: Db = pool): Promise<string | null> => {
    const { accountId, activeAccountId } = requestContext();
    const rows = await userAccounts(userId, db);
    if (accountId) return rows.some(row => row.account_id === accountId) ? accountId : null;
    return rows.find(row => row.open && row.account_id === activeAccountId)?.account_id ?? rows[0]?.account_id ?? null;
};

const EMPTY_FEES = { REG: 0, TAF: 0, CAT: 0, ORF: 0, OCC: 0 };

// An account's ledger through the Broker interface (positions, the trading account, every fill and cash activity, the traded tickers'
// splits for the replay), kept 5 seconds so one page's requests share it
const brokerLedgerCache = singleton("brokerLedgers", () => new Map<string, CacheEntry<Awaited<ReturnType<typeof loadBrokerLedger>>>>());
const loadBrokerLedger = async (accountId: string) => {
    const broker = getBroker();
    const [trade, positions, activities] = await Promise.all([
        broker.getTradeAccount(accountId), broker.listPositions(accountId), listAllActivities(broker, accountId, ["FILL", ...CASH_ACTIVITY_TYPES])
    ]);
    const traded = [...new Set(activities.flatMap(activity => (activity as { activity_type?: string; symbol?: string }).activity_type === "FILL" ? [String((activity as { symbol?: string }).symbol).toUpperCase()] : []))];
    const corporate = await loadCorporateActions(traded, positions.map(({ symbol }) => String(symbol)));
    return { trade, positions, activities, corporate, ledger: ledgerOf({ trade, positions, activities, splits: corporate.splits }) };
};
export const brokerLedger = (accountId: string) => cachePromise(brokerLedgerCache, accountId, 5000, () => loadBrokerLedger(accountId));
// Drops it after a change (an order, a transfer, a broker event), so the next read sees the change
export const forgetBrokerLedger = (accountId: string) => {
    brokerLedgerCache.delete(accountId);
};

// A user's account from the broker's ledger (lib/server/broker/sim/positions.ts): its fills as trades to replay (for dividends and
// the history), the traded tickers' splits and dividends (fetching any never fetched and refreshing the held tickers' once a day,
// then applying due corporate actions to the lots, so a split or merger is in place before the account is valued or traded; unsynced lists the tickers
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
    if (throughBroker()) {
        const { ledger, corporate } = await brokerLedger(accountId);
        return {
            accountId, transactions: tradesOf(ledger.fills), splits: corporate.splits, dividends: corporate.dividends, unsynced: corporate.unsynced, positions: ledger.positions,
            totalCash: ledger.totalCash, realizedPnl: ledger.realizedPnl, netDividends: ledger.netDividends, pendingTransferOut: ledger.pendingTransferOut,
            // Alpaca's instant credit isn't reported apart, and its accrued fees are one total
            unsettledInstant: 0, unsettledProceeds: ledger.unsettledProceeds, accruedFees: { ...EMPTY_FEES, REG: ledger.accruedFees }
        };
    }
    await advanceTransfers(accountId);
    const [transactions, held] = await Promise.all([fillsAsTrades(db, accountId), openLots(db, accountId)]);
    const heldTickers = [...new Set(held.map(({ symbol }) => symbol))];
    const { splits, dividends, unsynced } = await loadCorporateActions([...new Set(transactions.map(({ ticker }) => ticker.toUpperCase()))], heldTickers);
    await applyCorporateActions(db, accountId, heldTickers);
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
    if (!accountId) return [];
    return throughBroker() ? tradesOf((await brokerLedger(accountId)).ledger.fills) : fillsAsTrades(db, accountId);
};

// A fill (a FILL activity) as the pages' TransactionRow, with the P&L it realized against the lots it closed (FIFO)
export const toTransactionRow = (row: SimActivityRow, userId: string): TradeHistoryRow => ({
    id: row.id, user_id: userId, date: row.created_at.toISOString(), type: row.side === "buy" ? "BUY" : "SELL", ticker: row.symbol ?? "",
    price: String(Number(row.price)), quantity: String(Number(row.qty)), total: Math.abs(Number(row.net_amount)).toFixed(2),
    reason: row.reason === "LIQUIDATION" ? "LIQUIDATION" : null, quote_time: row.quote_time ? row.quote_time.toISOString() : null,
    fill_policy: (row.fill_policy ?? null) as TradeHistoryRow["fill_policy"], order_id: row.order_id ?? null, legacy_order_id: row.legacy_order_id ?? null,
    realized_pnl: row.realized_pl === null || row.realized_pl === undefined ? null : Number(row.realized_pl), settle_date: row.settle_date ?? null
});

// The user's fills, newest first (since a time, if given)
export const getFills = async (userId: string, { since }: { since?: Date } = {}, db: Db = pool): Promise<TradeHistoryRow[]> => {
    const accountId = await ledgerAccountId(userId, db);
    if (!accountId) return [];
    if (throughBroker()) {
        const { ledger } = await brokerLedger(accountId);
        return transactionRowsOf(ledger.fills, ledger.replay, userId).filter(row => !since || new Date(row.date) > since);
    }
    return (await listFills(db, accountId, { since })).map(row => toTransactionRow(row, userId));
};

// The user's cash ledger, oldest first, as CashActivityRows: the broker's cash activities (CSD deposits, CSW withdrawals, FEE fees,
// DIV dividends received or charged on shorts, INT margin interest, WH backup withholding, MA and CIL cash from corporate actions; fills are on the Trades tab)
export const loadCashActivity = async (userId: string, db: Db = pool): Promise<CashActivityRow[]> => {
    const accountId = await ledgerAccountId(userId, db);
    if (!accountId) return [];
    if (throughBroker()) return cashRowsOf((await brokerLedger(accountId)).activities, userId);
    const { rows } = await db.query<{ id: string; activity_type: string; created_at: Date; net_amount: string; description: string; symbol: string | null }>(
        "SELECT id, activity_type, created_at, net_amount, description, symbol FROM sim_activities WHERE account_id = $1 AND (activity_type IN ('CSD', 'CSW', 'FEE', 'DIV', 'INT', 'WH') OR (activity_type IN ('MA', 'CIL') AND net_amount <> 0)) ORDER BY created_at, id",
        [accountId]
    );
    const typeOf = (activity: string, amount: number): CashActivityRow["type"] =>
        activity === "DIV" ? (amount >= 0 ? "DIVIDEND_IN" : "DIVIDEND_OUT") : activity === "CSD" ? "DEPOSIT" : activity === "CSW" ? "WITHDRAW" : activity === "INT" ? "INTEREST" : activity === "WH" ? "WITHHOLDING"
            : activity === "MA" || activity === "CIL" ? (amount >= 0 ? "CORPORATE_ACTION_IN" : "CORPORATE_ACTION_OUT") : "FEE";
    return rows.map(row => ({
        id: row.id, user_id: userId, date: row.created_at.toISOString(), type: typeOf(row.activity_type, Number(row.net_amount)), method: row.description,
        amount: Math.abs(Number(row.net_amount)).toFixed(2), ticker: row.symbol, reference: null
    }));
};

// Orders with the reason each one ended, from the broker (the simulator keeps it; Alpaca sends it only with the order's trade event,
// so its orders have none)
export const withReasons = async <T extends BrokerOrder>(orders: T[]): Promise<(T & { reason: string | null })[]> => {
    const reasons = throughBroker() ? new Map<string, string>() : await orderReasons(orders.map(({ id }) => id));
    return orders.map(order => ({ ...order, reason: reasons.get(order.id) ?? null }));
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

// Posts the dividends paid since they were last checked to the user's ledger (DIV activities; the broker's postDividends). Call it
// inside withAccountLock with its client.
export const postDividends = async (userId: string, label: string, db: PoolClient) => {
    // Alpaca pays dividends itself
    if (throughBroker()) return [];
    const { accountId, splits, dividends } = await getAccount(userId, db);
    if (!accountId) return [];
    const posted = await postAccountDividends(db, accountId, { splits, dividends });
    if (posted.length > 0) {
        console.log(`${label}: posted ${posted.length} dividend${posted.length === 1 ? "" : "s"} for ${userId}: ${posted.map(({ symbol, net_amount }) => `${symbol} ${net_amount}`).join(", ")}`);
    }
    return posted;
};

// The broker's margin upkeep (lib/server/broker/sim/calls.ts's enforceMargin): meets the calls that are covered and liquidates for a
// call past its deadline, or for equity far below the maintenance requirement, during the regular session. It waits while any
// position's splits couldn't be fetched, since a missed split would misstate the positions. Returns the liquidation orders placed.
export const enforceMargin = async (userId: string, label: string, db: Db = pool) => {
    // Alpaca issues and enforces its own margin calls
    if (throughBroker()) return [];
    const { accountId, positions, unsynced } = await getAccount(userId, db);
    if (!accountId) return [];
    const unsure = positions.filter(({ ticker }) => unsynced.includes(ticker)).map(({ ticker }) => ticker);
    if (unsure.length > 0) {
        console.warn(`${label}: margin check for ${userId} skipped until ${unsure.join(", ")} corporate actions can be fetched`);
        return [];
    }
    return enforceAccountMargin(accountId);
};
