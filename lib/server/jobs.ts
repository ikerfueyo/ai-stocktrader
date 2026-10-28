import "server-only";
import type { PoolClient } from "pg";
import pool from "./db";
import { singleton } from "./cache";
import { fetchQuotes } from "./marketData";
import { getMarketStatus } from "./market";
import { withAccountLock } from "./portfolio";
import { updateAccount } from "./upkeep";
import { syncAssets } from "./assets";
import { syncCalendar } from "./calendar";
import { isSlotDue } from "./schedule";
import { easternParts } from "../marketHours";
import { advanceAccounts } from "./broker/sim/accounts";
import { advanceTransfers, fastForwardTransfers } from "./broker/sim/transfers";
import { applyDueCorporateActions, endOfDay } from "./broker/sim/positions";
import { matchOrders, processCorporateActionOrders } from "./broker/sim/orders";
import { generateAllDocuments } from "./broker/sim/documents";
import { accountsOnMargin, endOfDayMargin } from "./broker/sim/calls";
import { postDividends } from "./portfolio";

// The background jobs, checked every SIM_ORDER_MATCH_MS (default 5s). Each job is due every ORDER_MATCH_INTERVAL_MS (default 30s),
// every everyMs of its own, or at daily Eastern times (isSlotDue, so a run missed while the server was down happens when it's back). Jobs that write shared data run only in the
// leader process, the one holding a Postgres advisory lock (JOB_LOCK_KEY) on a client it keeps; jobs that fill in-process state
// (the market calendar) run in every process. BACKGROUND_JOBS=off turns them all off (instrumentation.ts).
const INTERVAL_MS = Number(process.env.ORDER_MATCH_INTERVAL_MS ?? 30000);
const ORDER_MATCH_MS = Number(process.env.SIM_ORDER_MATCH_MS ?? 5000);
const CHECK_MS = Math.min(INTERVAL_MS, ORDER_MATCH_MS > 0 ? ORDER_MATCH_MS : INTERVAL_MS);
const JOB_LOCK_KEY = 735061;
const LABEL = "Background job";

export interface Job {
    name: string;
    // Daily Eastern times ("HH:MM") it runs at; without them it runs on every check, unless it's manual (POST /api/dev/jobs only)
    slots?: string[];
    // How often it runs without slots (default INTERVAL_MS)
    everyMs?: number;
    manual?: boolean;
    leaderOnly: boolean;
    run: () => Promise<unknown>;
}

const state = singleton("backgroundJobs", () => ({
    started: false, running: false, leader: null as PoolClient | null, lastRuns: new Map<string, Date>(), jobsRunning: new Set<string>(), missingTables: new Set<string>()
}));

// Becomes the leader if no other process is; the lock lasts as long as the kept client's connection
const isLeader = async (): Promise<boolean> => {
    if (state.leader) return true;
    const client = await pool.connect();
    const { rows: [{ locked }] } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [JOB_LOCK_KEY]);
    if (!locked) {
        client.release();
        return false;
    }
    client.on("error", () => {
        state.leader = null;
    });
    state.leader = client;
    return true;
};

// The users whose accounts are on margin (borrowing, short or with an open call), with the symbols they hold
const usersToCheck = async (): Promise<{ users: string[]; tickers: string[] }> => {
    const accounts = await accountsOnMargin();
    if (accounts.length === 0) return { users: [], tickers: [] };
    const { rows } = await pool.query<{ user_id: string; ticker: string | null }>(
        `SELECT b.user_id, l.symbol AS ticker FROM broker_accounts b LEFT JOIN sim_lots l ON l.account_id = b.account_id AND l.qty > 0 WHERE b.account_id = ANY($1)`, [accounts]
    );
    return { users: [...new Set(rows.map(({ user_id }) => user_id))], tickers: [...new Set(rows.flatMap(({ ticker }) => ticker ? [ticker.toUpperCase()] : []))] };
};

// Dividends and the margin check (updateAccount) for every user on margin, so calls are met and liquidations happen without anyone
// loading a page (orders are the sim-orders job's). The broker only liquidates during the regular session.
const updateAccounts = async () => {
    const market = await getMarketStatus();
    const { users, tickers } = await usersToCheck();
    if (users.length === 0) return;
    // Warm the quote cache with every ticker at once (one bulk call when the plan has it), so each user's checks reuse it
    if (market.session !== "closed" && tickers.length > 0) await Promise.allSettled(fetchQuotes(tickers));
    for (const userId of users) {
        await withAccountLock(userId, db => updateAccount(userId, LABEL, db)).catch(error => console.error(`${LABEL}: ${userId}: ${error.message}`));
    }
};

// Corporate actions that have taken effect: applied to every account holding the symbol, their effect on open orders, and watchlists
// following symbol changes
const runCorporateActions = async () => {
    const accounts = await applyDueCorporateActions();
    const orders = await processCorporateActionOrders();
    const { rowCount } = await pool.query(
        `UPDATE watchlist w SET ticker = c.new_ticker FROM corporate_actions c
         WHERE c."type" = 'NAME_CHANGE' AND c.ex_date <= $1 AND w.ticker = c.ticker
           AND NOT EXISTS (SELECT 1 FROM watchlist o WHERE o.user_id = w.user_id AND o.ticker = c.new_ticker)`,
        [easternParts(new Date()).dateKey]
    );
    return { accounts, orders, watchlist: rowCount ?? 0 };
};

// Posts due dividends for every user whose account has fills, under each user's account lock
const postAllDividends = async () => {
    const { rows } = await pool.query<{ user_id: string }>(
        "SELECT DISTINCT b.user_id FROM sim_activities a JOIN broker_accounts b ON b.account_id = a.account_id WHERE a.activity_type = 'FILL'"
    );
    for (const { user_id } of rows) {
        await withAccountLock(user_id, db => postDividends(user_id, LABEL, db)).catch(error => console.error(`${LABEL}: dividends: ${user_id}: ${error.message}`));
    }
};

export const JOBS: Job[] = [
    { name: "accounts", leaderOnly: true, run: updateAccounts },
    // The simulator's order engine: fills, triggers, expiries and leg activations for every working order
    { name: "sim-orders", leaderOnly: true, everyMs: ORDER_MATCH_MS > 0 ? ORDER_MATCH_MS : INTERVAL_MS, run: () => matchOrders() },
    // The simulator's account reviews and options approvals that are due (reading an account advances it too)
    { name: "sim-accounts", leaderOnly: true, run: () => advanceAccounts() },
    // The simulator's transfers that are due to clear, complete or come back (reading an account's transfers advances them too)
    { name: "sim-transfers", leaderOnly: true, run: () => advanceTransfers() },
    // The end of the trading day: deduct the day's regulatory fees, then keep each account's closing balances (last_equity), issue
    // margin calls, accrue margin interest (posted at month end) and charge hard-to-borrow fees
    { name: "eod", slots: ["20:15"], leaderOnly: true, run: async () => ({ ...(await endOfDay()), ...(await endOfDayMargin()) }) },
    // Corporate actions apply before the pre-market opens (reading an account, and every order match, apply them too)
    { name: "corporate-actions", slots: ["03:45"], leaderOnly: true, run: runCorporateActions },
    // Documents that are due: the previous trading day's confirmations, statements after a month's first weekend, 1099s from Feb 15
    { name: "documents", slots: ["06:30"], leaderOnly: true, run: () => generateAllDocuments() },
    // Dividends paid overnight post before the open, for every account with fills (reading an account posts them too)
    { name: "dividends", slots: ["06:00"], leaderOnly: true, run: postAllDividends },
    // Development only (POST /api/dev/jobs): moves every in-progress transfer one step now, ignoring the banking calendar
    { name: "settle-transfers", leaderOnly: true, manual: true, run: () => fastForwardTransfers() },
    // Alpaca refreshes its asset flags 3 times a day, the last at 8:20 a.m. ET
    { name: "assets", slots: ["04:30", "08:30", "16:30"], leaderOnly: true, run: () => syncAssets(LABEL) },
    { name: "calendar", slots: ["03:00"], leaderOnly: false, run: () => syncCalendar(LABEL) }
];

// Runs a job now (the schedule, or POST /api/dev/jobs), unless it's already running; returns false when it was. A failed run isn't
// recorded, so a daily job is retried on the next check rather than at its next slot. A job whose table doesn't exist yet (a
// migration not applied) is skipped quietly after one warning.
export const runJob = async (job: Job): Promise<boolean> => {
    if (state.jobsRunning.has(job.name)) return false;
    state.jobsRunning.add(job.name);
    try {
        await job.run();
        state.lastRuns.set(job.name, new Date());
    } catch (error) {
        if ((error as { code?: string }).code !== "42P01") throw error;
        if (!state.missingTables.has(job.name)) console.warn(`${LABEL}: ${job.name}: ${(error as Error).message}; apply the pending migrations in db/migrations`);
        state.missingTables.add(job.name);
    } finally {
        state.jobsRunning.delete(job.name);
    }
    return true;
};

const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
        const now = new Date();
        const due = JOBS.filter(job => !job.manual).filter(job => {
            const last = state.lastRuns.get(job.name) ?? null;
            if (job.slots) return isSlotDue(job.slots, last, now);
            // A little slack, so a job due every check doesn't skip one when the checks drift
            return !last || now.getTime() - last.getTime() >= (job.everyMs ?? INTERVAL_MS) - 250;
        });
        const leader = due.some(job => job.leaderOnly) && await isLeader().catch(error => {
            console.error(`${LABEL}: ${error.message}`);
            return false;
        });
        for (const job of due) {
            if (job.leaderOnly && !leader) continue;
            await runJob(job).catch(error => console.error(`${LABEL}: ${job.name}: ${error instanceof Error ? error.message : error}`));
        }
    } finally {
        state.running = false;
    }
};

export const startBackgroundJobs = () => {
    if (state.started || !(INTERVAL_MS > 0)) return;
    state.started = true;
    setInterval(tick, CHECK_MS).unref();
    // The calendar and the universe load right away rather than after the first interval
    setTimeout(tick, 1000).unref();
    console.log(`${LABEL}: account upkeep every ${INTERVAL_MS / 1000}s; orders every ${CHECK_MS / 1000}s; ${JOBS.filter(job => job.slots).map(job => `${job.name} at ${job.slots!.join(", ")} ET`).join("; ")}`);
};
