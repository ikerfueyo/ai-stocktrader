import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { addDays, easternParts } from "../../../marketHours";
import { emitEvent } from "./accounts";
import { DEFICIT_COLUMNS, marginLevel, type IntradayDeficitRow } from "./marginAccount";
import {
    dayDeficit, deficitDeadlines, deficitSatisfied, isDeMinimis, isPractice, PRACTICE_WINDOW_DAYS, reducesMarginLevel, restrictionEnd
} from "./intradayMargin";

// FINRA Rule 4210(d)(2) intraday margin in the simulator (the rules are ./intradayMargin.ts): each fill on a margin account that lowers
// its margin level below zero is recorded (trackMarginLevel, around the fill), and at each end of day (endOfDayIntraday, from the eod
// job's endOfDayMargin) the day's deficit is issued, earlier ones are checked for satisfaction, a deficit still unmet at its 5th
// business day's close restricts the account for 90 days when the account makes a practice of it, and one unmet at its 15th expires.
// Withdrawals are IML-reducing too, but they're limited to the excess over Reg T initial margin, so they never leave the level below
// zero and aren't tracked. Intraday deficits are never liquidated.

const LABEL = "Sim intraday margin";
// How many deficits beyond de minimis, unmet at their 5th business day in 12 months, make a practice (this one included)
const PRACTICE_MISSES = Number(process.env.SIM_INTRADAY_PRACTICE_MISSES ?? 2);

const dayOf = (date: Date) => easternParts(date).dateKey;

// Runs fn (a fill, or an option exercise or assignment, inside the account's transaction) and records the margin level after it when
// it lowered the level below zero, on margin accounts only. A failure to price the account is logged and doesn't stop the fill.
export const trackMarginLevel = async <T>(db: PoolClient, accountId: string, fn: () => Promise<T>, { symbol, at = new Date() }: { symbol?: string; at?: Date } = {}): Promise<T> => {
    const before = await marginLevel(db, accountId, at).catch(error => {
        console.error(`${LABEL}: pricing ${accountId} before a fill: ${error instanceof Error ? error.message : error}`);
        return null;
    });
    const result = await fn();
    if (before === null) return result;
    try {
        const after = await marginLevel(db, accountId, at);
        if (after !== null && after < 0 && reducesMarginLevel(before, after)) {
            await db.query(
                `INSERT INTO sim_intraday_levels (account_id, "date", at, before_level, level, symbol) VALUES ($1, $2, $3, $4, $5, $6)`,
                [accountId, dayOf(at), at, before, after, symbol ?? null]
            );
        }
    } catch (error) {
        console.error(`${LABEL}: pricing ${accountId} after a fill: ${error instanceof Error ? error.message : error}`);
    }
    return result;
};

const deficitEvent = (db: PoolClient, accountId: string, event: string, row: Pick<IntradayDeficitRow, "id" | "amount" | "date" | "restrict_on" | "expire_on" | "de_minimis" | "restricted_until">, at: Date) =>
    emitEvent(accountId, "accounts", {
        account_id: accountId, event,
        intraday_margin_deficit: {
            id: row.id, amount: String(row.amount), date: row.date, restrict_on: row.restrict_on, expire_on: row.expire_on, de_minimis: row.de_minimis,
            restricted_until: row.restricted_until
        }
    }, at, db);

// Net deposits (deposits less withdrawals) since a deficit's day ended: on later days, or that day after its end of day ran
const netDepositsSince = async (db: PoolClient, accountId: string, deficit: Pick<IntradayDeficitRow, "date" | "issued_at">) => {
    const { rows: [{ amount }] } = await db.query<{ amount: string }>(
        `SELECT COALESCE(SUM(net_amount), 0) AS amount FROM sim_activities
         WHERE account_id = $1 AND activity_type IN ('CSD', 'CSW') AND ("date" > $2 OR ("date" = $2 AND created_at > $3))`, [accountId, deficit.date, deficit.issued_at]
    );
    return Number(amount);
};

// The account's intraday margin at the close of today, a trading day (inside its transaction, holding its lock), given its closing
// equity and margin level: earlier deficits satisfied, missed (with a restriction when it's a practice) or expired, then today's
// deficit issued. Each step happens once, so running it again changes nothing.
export const endOfDayIntraday = async (db: PoolClient, accountId: string, today: string, { equity, level }: { equity: number; level: number }, now = new Date()) => {
    const result = { issued: 0, met: 0, restricted: 0, expired: 0 };
    const { rows: earlier } = await db.query<IntradayDeficitRow>(
        `SELECT ${DEFICIT_COLUMNS} FROM sim_intraday_deficits WHERE account_id = $1 AND "date" < $2 AND met_at IS NULL AND (status = 'open' OR restricted_until >= $2) ORDER BY sim_intraday_deficits."date"`,
        [accountId, today]
    );
    for (const row of earlier) {
        const amount = Number(row.amount);
        if (deficitSatisfied({ amount, deposits: await netDepositsSince(db, accountId, row), levelIncrease: level - Number(row.start_level) })) {
            await db.query("UPDATE sim_intraday_deficits SET met_at = $2, status = CASE WHEN status = 'open' THEN 'met' ELSE status END WHERE id = $1", [row.id, now]);
            await deficitEvent(db, accountId, "intraday_margin_deficit_met", row, now);
            result.met++;
            continue;
        }
        if (row.status !== "open") continue;
        if (!row.missed && today >= row.restrict_on) {
            await db.query("UPDATE sim_intraday_deficits SET missed = true WHERE id = $1", [row.id]);
            if (!row.de_minimis) {
                const { rows: [{ misses }] } = await db.query<{ misses: string }>(
                    `SELECT COUNT(*) AS misses FROM sim_intraday_deficits WHERE account_id = $1 AND NOT de_minimis AND (missed OR id = $2) AND "date" > $3`,
                    [accountId, row.id, addDays(today, -PRACTICE_WINDOW_DAYS)]
                );
                if (isPractice(Number(misses), PRACTICE_MISSES)) {
                    const restrictedUntil = restrictionEnd(row.restrict_on);
                    await db.query("UPDATE sim_intraday_deficits SET restricted_until = $2 WHERE id = $1", [row.id, restrictedUntil]);
                    await deficitEvent(db, accountId, "intraday_margin_restriction", { ...row, restricted_until: restrictedUntil }, now);
                    console.log(`${LABEL}: ${accountId} restricted until ${restrictedUntil} for the ${row.date} deficit of $${row.amount}`);
                    result.restricted++;
                }
            }
        }
        if (today >= row.expire_on) {
            await db.query("UPDATE sim_intraday_deficits SET status = 'expired' WHERE id = $1", [row.id]);
            result.expired++;
        }
    }
    const { rows: levels } = await db.query<{ at: Date; level: string }>(`SELECT at, level FROM sim_intraday_levels WHERE account_id = $1 AND "date" = $2`, [accountId, today]);
    if (levels.length === 0) return result;
    const { rows: flows } = await db.query<{ created_at: Date; net_amount: string }>(
        `SELECT created_at, net_amount FROM sim_activities WHERE account_id = $1 AND activity_type IN ('CSD', 'CSW') AND "date" = $2`, [accountId, today]
    );
    const amount = dayDeficit(levels.map(({ at, level }) => ({ at, level: Number(level) })), flows.map(({ created_at, net_amount }) => ({ at: created_at, amount: Number(net_amount) })));
    if (!(amount >= 0.01)) return result;
    const { restrictOn, expireOn } = deficitDeadlines(today);
    const row = { id: randomUUID(), amount: String(amount), date: today, restrict_on: restrictOn, expire_on: expireOn, de_minimis: isDeMinimis(amount, equity), restricted_until: null };
    const { rowCount } = await db.query(
        `INSERT INTO sim_intraday_deficits (id, account_id, "date", amount, equity, start_level, de_minimis, restrict_on, expire_on, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (account_id, "date") DO NOTHING`,
        [row.id, accountId, today, amount, equity, level, row.de_minimis, restrictOn, expireOn, now]
    );
    if (rowCount) {
        await deficitEvent(db, accountId, "intraday_margin_deficit", row, now);
        result.issued++;
    }
    return result;
};
