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
import { advanceAccounts } from "./broker/sim/accounts";
import { advanceTransfers, fastForwardTransfers } from "./broker/sim/transfers";
import { endOfDay } from "./broker/sim/positions";
import { postDividends } from "./portfolio";

// The background jobs, checked every ORDER_MATCH_INTERVAL_MS (default 30s). Each job is due on every check, or at daily Eastern
// times (isSlotDue, so a run missed while the server was down happens when it's back). Jobs that write shared data run only in the
// leader process, the one holding a Postgres advisory lock (JOB_LOCK_KEY) on a client it keeps; jobs that fill in-process state
// (the market calendar) run in every process. BACKGROUND_JOBS=off turns them all off (instrumentation.ts).
const INTERVAL_MS = Number(process.env.ORDER_MATCH_INTERVAL_MS ?? 30000);
const JOB_LOCK_KEY = 735061;
const LABEL = "Background job";

export interface Job {
    name: string;
    // Daily Eastern times ("HH:MM") it runs at; without them it runs on every check, unless it's manual (POST /api/dev/jobs only)
    slots?: string[];
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

// Users with open orders, and, while the market is open, users with a short (an open short lot) for the buy-in check
const usersToCheck = async (marketOpen: boolean): Promise<{ users: string[]; tickers: string[] }> => {
    const { rows } = await pool.query<{ user_id: string; ticker: string }>(
        `SELECT user_id, ticker FROM orders WHERE status = 'OPEN'
         UNION
         SELECT b.user_id, l.symbol AS ticker FROM sim_lots l JOIN broker_accounts b ON b.account_id = l.account_id
         WHERE $1 AND l.side = 'short' AND l.qty > 0`,
        [marketOpen]
    );
    return { users: [...new Set(rows.map(({ user_id }) => user_id))], tickers: [...new Set(rows.map(({ ticker }) => ticker.toUpperCase()))] };
};

// Dividends, buy-ins and order matching (updateAccount) for every user with open orders or a short, so limit and stop orders fill
// and buy-ins happen without anyone loading a page. While the market is closed it only expires DAY orders.
const updateAccounts = async () => {
    const market = await getMarketStatus();
    const { users, tickers } = await usersToCheck(market.open);
    if (users.length === 0) return;
    // Warm the quote cache with every ticker at once (one bulk call when the plan has it), so each user's checks reuse it
    if (market.open && tickers.length > 0) await Promise.allSettled(fetchQuotes(tickers));
    for (const userId of users) {
        await withAccountLock(userId, db => updateAccount(userId, LABEL, db)).catch(error => console.error(`${LABEL}: ${userId}: ${error.message}`));
    }
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
    // The simulator's account reviews and options approvals that are due (reading an account advances it too)
    { name: "sim-accounts", leaderOnly: true, run: () => advanceAccounts() },
    // The simulator's transfers that are due to clear, complete or come back (reading an account's transfers advances them too)
    { name: "sim-transfers", leaderOnly: true, run: () => advanceTransfers() },
    // The end of the trading day: deduct the day's regulatory fees and keep each account's closing balances (last_equity)
    { name: "eod", slots: ["20:15"], leaderOnly: true, run: () => endOfDay() },
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
        const due = JOBS.filter(job => !job.manual).filter(job => !job.slots || isSlotDue(job.slots, state.lastRuns.get(job.name) ?? null, now));
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
    setInterval(tick, INTERVAL_MS).unref();
    // The calendar and the universe load right away rather than after the first interval
    setTimeout(tick, 1000).unref();
    console.log(`${LABEL}: account upkeep every ${INTERVAL_MS / 1000}s; ${JOBS.filter(job => job.slots).map(job => `${job.name} at ${job.slots!.join(", ")} ET`).join("; ")}`);
};
