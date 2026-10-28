import "server-only";
import { randomUUID } from "node:crypto";
import pool from "../db";
import { getBroker } from "../broker";
import { HttpError, isHttpError } from "../httpError";
import { notify } from "../notifications";
import { requireTradableStock } from "../assets";
import { followingDate, nextScheduledDate, runDateFor, type Frequency } from "../../automation";
import { easternParts, sessionOn } from "../../marketHours";
import type { RecurringInvestment } from "../../types";

// Recurring investments (app-level, any broker): on each scheduled date's trading day, from RUN_AFTER Eastern (after overnight
// dividends and settlement) until the close, a day notional market order for the amount, which fills at the open (or at once during
// the session).
// Its client_order_id is recurring-<id>-<scheduled date>, so a date is bought at most once whatever happens to the process. A refusal
// (not enough buying power, an account that can't trade, a stock no longer tradable) pauses it and notifies the user; dates missed
// while the server was down run once, not once each.
const RUN_AFTER = "06:45";
const LABEL = "Recurring investments";
const FREQUENCIES: Frequency[] = ["daily", "weekly", "biweekly", "monthly"];

interface RecurringRow {
    id: string; user_id: string; account_id: string; symbol: string; amount: string; frequency: Frequency; start_date: string; next_date: string;
    status: RecurringInvestment["status"]; pause_reason: string | null; last_run_date: string | null;
}
const COLUMNS = `id, user_id, account_id, symbol, amount, frequency, start_date::text, next_date::text, status, pause_reason, last_run_date::text`;

const toInvestment = (row: RecurringRow): RecurringInvestment => ({
    id: row.id, accountId: row.account_id, symbol: row.symbol, amount: Number(row.amount), frequency: row.frequency, startDate: row.start_date,
    nextDate: row.next_date, nextRunDate: runDateFor(row.next_date), status: row.status, pauseReason: row.pause_reason, lastRunDate: row.last_run_date
});

const today = () => easternParts(new Date()).dateKey;

// The first scheduled date still to run: its trading day is today only before today's close, and after the day it last ran
const firstDate = (frequency: Frequency, start: string, lastRun: string | null, now = new Date()) => {
    const day = easternParts(now).dateKey;
    const session = sessionOn(day);
    let next = nextScheduledDate(frequency, start, day);
    while ((runDateFor(next) === day && (!session || now >= session.close)) || (lastRun !== null && runDateFor(next) <= lastRun)) next = followingDate(frequency, start, next);
    return next;
};

// The next scheduled date whose trading day is after the given day
const nextAfter = (frequency: Frequency, start: string, scheduled: string, day: string) => {
    let next = followingDate(frequency, start, scheduled);
    while (runDateFor(next) <= day) next = followingDate(frequency, start, next);
    return next;
};

export const listRecurring = async (userId: string): Promise<RecurringInvestment[]> => {
    const { rows } = await pool.query<RecurringRow>(`SELECT ${COLUMNS} FROM recurring_investments WHERE user_id = $1 AND status <> 'cancelled' ORDER BY created_at`, [userId]);
    return rows.map(toInvestment);
};

const findRecurring = async (userId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError("Recurring investment not found", 404);
    const { rows: [row] } = await pool.query<RecurringRow>(`SELECT ${COLUMNS} FROM recurring_investments WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'`, [id, userId]);
    if (!row) throw new HttpError("Recurring investment not found", 404);
    return row;
};

const checkInput = ({ amount, frequency, startDate }: { amount: number; frequency: string; startDate?: string }) => {
    if (!(amount >= 1) || amount > 100000 || Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) throw new HttpError("The amount must be from $1 to $100,000, in cents", 400);
    if (!FREQUENCIES.includes(frequency as Frequency)) throw new HttpError("Pick how often to buy", 400);
    if (startDate === undefined) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) throw new HttpError("The start date isn't a date", 400);
    if (startDate < today()) throw new HttpError("The start date can't be in the past", 400);
};

// POST /api/recurring: a stock that can be bought in fractions (notional orders), an amount, how often and the first date
export const createRecurring = async (userId: string, accountId: string, input: { symbol: string; amount: number; frequency: Frequency; startDate: string }) => {
    checkInput(input);
    const asset = await requireTradableStock(input.symbol);
    const symbol = asset?.symbol ?? input.symbol.toUpperCase();
    const brokerAsset = await getBroker().getAsset(symbol).catch(() => null);
    if (brokerAsset && !brokerAsset.fractionable) throw new HttpError(`${symbol} can't be bought in fractions, so it can't be bought by the dollar`, 400);
    const { rows: [{ count }] } = await pool.query<{ count: string }>("SELECT count(*) FROM recurring_investments WHERE user_id = $1 AND status <> 'cancelled'", [userId]);
    if (Number(count) >= 25) throw new HttpError("You can have up to 25 recurring investments", 400);
    const next = firstDate(input.frequency, input.startDate, null);
    const { rows: [row] } = await pool.query<RecurringRow>(
        `INSERT INTO recurring_investments (id, user_id, account_id, symbol, amount, frequency, start_date, next_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
        [randomUUID(), userId, accountId, symbol, input.amount.toFixed(2), input.frequency, input.startDate, next]
    );
    return toInvestment(row);
};

// PATCH /api/recurring/[id]: the amount or schedule, or pause and resume. Resuming moves a schedule that fell behind to its next date.
export const updateRecurring = async (userId: string, id: string, changes: { amount?: number; frequency?: Frequency; startDate?: string; status?: "active" | "paused" }) => {
    const row = await findRecurring(userId, id);
    const amount = changes.amount ?? Number(row.amount);
    const frequency = changes.frequency ?? row.frequency;
    const startDate = changes.startDate ?? row.start_date;
    checkInput({ amount, frequency, startDate: changes.startDate });
    const status = changes.status ?? row.status;
    if (status !== "active" && status !== "paused") throw new HttpError("A recurring investment is active or paused", 400);
    const next = firstDate(frequency, startDate, row.last_run_date);
    const { rows: [updated] } = await pool.query<RecurringRow>(
        `UPDATE recurring_investments SET amount = $3, frequency = $4, start_date = $5, next_date = $6, status = $7::varchar, pause_reason = CASE WHEN $7::varchar = 'active' THEN NULL ELSE pause_reason END,
           updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
        [id, userId, amount.toFixed(2), frequency, startDate, next, status]
    );
    return toInvestment(updated);
};

export const cancelRecurring = async (userId: string, id: string) => {
    await findRecurring(userId, id);
    await pool.query("UPDATE recurring_investments SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2", [id, userId]);
};

// The recurring job: places every active investment due today (on a trading day, from RUN_AFTER until the close); dates missed
// earlier run once now
export const runRecurring = async (now = new Date()) => {
    const { dateKey: day, time } = easternParts(now);
    const session = sessionOn(day);
    if (!session || time < RUN_AFTER || now >= session.close) return { placed: 0, paused: 0 };
    const { rows } = await pool.query<RecurringRow>(`SELECT ${COLUMNS} FROM recurring_investments WHERE status = 'active' AND next_date <= $1 ORDER BY next_date, created_at`, [day]);
    let placed = 0, paused = 0;
    for (const row of rows) {
        if (runDateFor(row.next_date) > day) continue;
        const advance = (orderId: string | null) => pool.query(
            "UPDATE recurring_investments SET next_date = $2, last_run_date = $3, last_order_id = COALESCE($4, last_order_id), updated_at = now() WHERE id = $1",
            [row.id, nextAfter(row.frequency, row.start_date, row.next_date, day), day, orderId]
        );
        try {
            const order = await getBroker().createOrder(row.account_id, {
                symbol: row.symbol, side: "buy", type: "market", time_in_force: "day", notional: Number(row.amount).toFixed(2), client_order_id: `recurring-${row.id}-${row.next_date}`
            } as never);
            await advance(order.id);
            placed++;
        } catch (error) {
            if (!isHttpError(error) || error.status >= 500) {
                // Tried again on the next check
                console.error(`${LABEL}: ${row.id}: ${error instanceof Error ? error.message : error}`);
                continue;
            }
            // This date was already ordered
            if (/client_order_id must be unique/.test(error.message)) {
                await advance(null);
                continue;
            }
            const reason = /buying power/i.test(error.message) ? `Not enough buying power for $${Number(row.amount).toFixed(2)} of ${row.symbol} on ${day}` : error.message;
            await pool.query("UPDATE recurring_investments SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1", [row.id, reason.slice(0, 500)]);
            await notify(row.user_id, row.account_id, {
                kind: "recurring", title: `Recurring buy of ${row.symbol} paused`, body: `${reason}. Resume it when it can run again.`, link: "/notifications?tab=recurring",
                dedupeKey: `recurring:${row.id}:${row.next_date}`
            });
            paused++;
        }
    }
    return { placed, paused };
};
