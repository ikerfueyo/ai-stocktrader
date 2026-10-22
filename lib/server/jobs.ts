import "server-only";
import type { PoolClient } from "pg";
import pool from "./db";
import { singleton } from "./cache";
import { fetchQuotes } from "./alphaVantage";
import { getMarketStatus } from "./market";
import { withAccountLock } from "./portfolio";
import { updateAccount } from "./upkeep";

// The background job: every ORDER_MATCH_INTERVAL_MS (default 30s) it runs updateAccount (dividends, buy-ins, order matching) for
// every user with open orders or a short position, so limit and stop orders fill and buy-ins happen without anyone loading a page.
// While the market is closed it only expires DAY orders. Only one server process runs it: the one holding a Postgres advisory
// lock (JOB_LOCK_KEY) on a client it keeps. BACKGROUND_JOBS=off turns it off (instrumentation.ts).
const INTERVAL_MS = Number(process.env.ORDER_MATCH_INTERVAL_MS ?? 30000);
const JOB_LOCK_KEY = 735061;
const LABEL = "Background job";

const state = singleton("backgroundJobs", () => ({ started: false, running: false, leader: null as PoolClient | null }));

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

// Users with open orders, and users with a short (by raw share counts; splits don't change a position's sign)
const usersToCheck = async (marketOpen: boolean): Promise<{ users: string[]; tickers: string[] }> => {
    const { rows } = await pool.query<{ user_id: string; ticker: string }>(
        `SELECT user_id, ticker FROM orders WHERE status = 'OPEN'
         UNION
         SELECT user_id, ticker FROM (
             SELECT user_id, UPPER(ticker) AS ticker, SUM(CASE "type" WHEN 'BUY' THEN quantity ELSE -quantity END) AS held
             FROM transactions GROUP BY user_id, UPPER(ticker)
         ) positions WHERE held < 0 AND $1`,
        [marketOpen]
    );
    return { users: [...new Set(rows.map(({ user_id }) => user_id))], tickers: [...new Set(rows.map(({ ticker }) => ticker.toUpperCase()))] };
};

const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
        if (!(await isLeader())) return;
        const market = await getMarketStatus();
        const { users, tickers } = await usersToCheck(market.open);
        if (users.length === 0) return;
        // Warm the quote cache with every ticker at once (one bulk call when the plan has it), so each user's checks reuse it
        if (market.open && tickers.length > 0) await Promise.allSettled(fetchQuotes(tickers));
        for (const userId of users) {
            await withAccountLock(userId, db => updateAccount(userId, LABEL, db)).catch(error => console.error(`${LABEL}: ${userId}: ${error.message}`));
        }
    } catch (error) {
        console.error(`${LABEL}: ${error instanceof Error ? error.message : error}`);
    } finally {
        state.running = false;
    }
};

export const startBackgroundJobs = () => {
    if (state.started || !(INTERVAL_MS > 0)) return;
    state.started = true;
    setInterval(tick, INTERVAL_MS).unref();
    console.log(`${LABEL}: checking orders, dividends and buy-ins every ${INTERVAL_MS / 1000}s`);
};
