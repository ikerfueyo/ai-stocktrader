import "server-only";
import { randomUUID } from "node:crypto";
import pool from "../db";
import { HttpError } from "../httpError";
import { fetchQuote, fetchQuotes, isStaleQuote } from "../marketData";
import { getMarketStatus } from "../market";
import { requireTradableStock } from "../assets";
import { notify } from "../notifications";
import { alertFires, describeAlert, type AlertCondition } from "../../automation";
import { easternParts } from "../../marketHours";
import type { PriceAlert } from "../../types";

// Price alerts (app-level): checked by the alerts job during the regular session against the cached quotes (one bulk call for every
// symbol). A level alert fires when the price crosses it, a change alert when the day's move from the previous close reaches the
// percentage (once a day). Each fires once and is done, or with rearm stays active for the next crossing (or the next day).
const CONDITIONS: AlertCondition[] = ["above", "below", "change_up", "change_down"];
const LABEL = "Price alerts";

interface AlertRow {
    id: string; user_id: string; symbol: string; condition: AlertCondition; threshold: string; rearm: boolean; status: PriceAlert["status"];
    last_price: string | null; triggered_at: Date | null; triggered_on: string | null; created_at: Date;
}
const COLUMNS = "id, user_id, symbol, condition, threshold, rearm, status, last_price, triggered_at, triggered_on::text, created_at";
const num = (value: string | null) => value === null ? null : Number(value);

const toAlert = (row: AlertRow): PriceAlert => ({
    id: row.id, symbol: row.symbol, condition: row.condition, threshold: Number(row.threshold), rearm: row.rearm, status: row.status, lastPrice: num(row.last_price),
    triggeredAt: row.triggered_at?.toISOString() ?? null, createdAt: row.created_at.toISOString()
});

export const listAlerts = async (userId: string, symbol?: string): Promise<PriceAlert[]> => {
    const { rows } = await pool.query<AlertRow>(
        `SELECT ${COLUMNS} FROM price_alerts WHERE user_id = $1 AND status <> 'cancelled' AND ($2::text IS NULL OR symbol = $2) ORDER BY status, created_at DESC`, [userId, symbol?.toUpperCase() ?? null]
    );
    return rows.map(toAlert);
};

// POST /api/alerts. A level alert starts from the current price, so it has to be on the side the price will cross from.
export const createAlert = async (userId: string, input: { symbol: string; condition: AlertCondition; threshold: number; rearm?: boolean }) => {
    if (!CONDITIONS.includes(input.condition)) throw new HttpError("Pick what the alert watches for", 400);
    const change = input.condition === "change_up" || input.condition === "change_down";
    if (!(input.threshold > 0) || (change && input.threshold > 100) || input.threshold > 1e6) throw new HttpError(change ? "The change must be between 0% and 100%" : "The price must be positive", 400);
    const asset = await requireTradableStock(input.symbol);
    const symbol = asset?.symbol ?? input.symbol.toUpperCase();
    const { price } = await fetchQuote(symbol);
    if (input.condition === "above" && price >= input.threshold) throw new HttpError(`${symbol} is already at $${price.toFixed(2)}, at or above $${input.threshold}`, 400);
    if (input.condition === "below" && price <= input.threshold) throw new HttpError(`${symbol} is already at $${price.toFixed(2)}, at or below $${input.threshold}`, 400);
    const { rows: [{ count }] } = await pool.query<{ count: string }>("SELECT count(*) FROM price_alerts WHERE user_id = $1 AND status = 'active'", [userId]);
    if (Number(count) >= 100) throw new HttpError("You can have up to 100 active alerts", 400);
    const { rows: [row] } = await pool.query<AlertRow>(
        `INSERT INTO price_alerts (id, user_id, symbol, condition, threshold, rearm, last_price) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [randomUUID(), userId, symbol, input.condition, input.threshold, input.rearm === true, price]
    );
    return toAlert(row);
};

export const cancelAlert = async (userId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError("Alert not found", 404);
    const { rowCount } = await pool.query("UPDATE price_alerts SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'", [id, userId]);
    if (!rowCount) throw new HttpError("Alert not found", 404);
};

// The alerts job: every active alert against its symbol's quote, during the regular session
export const checkAlerts = async (now = new Date()) => {
    const market = await getMarketStatus();
    if (!market.open) return { checked: 0, fired: 0 };
    const { rows } = await pool.query<AlertRow>(`SELECT ${COLUMNS} FROM price_alerts WHERE status = 'active'`);
    if (rows.length === 0) return { checked: 0, fired: 0 };
    const symbols = [...new Set(rows.map(({ symbol }) => symbol))];
    const results = await Promise.allSettled(fetchQuotes(symbols));
    const quotes = new Map(symbols.flatMap((symbol, index) => {
        const result = results[index];
        return result.status === "fulfilled" && !isStaleQuote(result.value, now) ? [[symbol, result.value] as const] : [];
    }));
    const day = easternParts(now).dateKey;
    let fired = 0;
    for (const row of rows) {
        const quote = quotes.get(row.symbol);
        if (!quote) continue;
        const threshold = Number(row.threshold);
        const fires = alertFires({ condition: row.condition, threshold, lastPrice: num(row.last_price), triggeredOn: row.triggered_on }, { price: quote.price, previousClose: quote.previousClose ?? null }, day);
        try {
            if (fires) {
                const change = quote.previousClose ? (quote.price / quote.previousClose - 1) * 100 : null;
                await notify(row.user_id, null, {
                    kind: "alerts", title: `Price alert: ${describeAlert(row.symbol, row.condition, threshold)}`,
                    body: `${row.symbol} is at $${quote.price.toFixed(2)}${change === null ? "" : ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% today)`}.${row.rearm ? " The alert stays on." : ""}`,
                    link: `/trading/${row.symbol}`, dedupeKey: `alert:${row.id}:${now.toISOString().slice(0, 16)}`
                });
                fired++;
            }
            await pool.query(
                `UPDATE price_alerts SET last_price = $2, status = CASE WHEN $3 AND NOT rearm THEN 'triggered' ELSE status END,
                   triggered_at = CASE WHEN $3 THEN $4 ELSE triggered_at END, triggered_on = CASE WHEN $3 THEN $5::date ELSE triggered_on END WHERE id = $1 AND status = 'active'`,
                [row.id, quote.price, fires, now, day]
            );
        } catch (error) {
            console.error(`${LABEL}: ${row.id}: ${error instanceof Error ? error.message : error}`);
        }
    }
    return { checked: rows.length, fired };
};
