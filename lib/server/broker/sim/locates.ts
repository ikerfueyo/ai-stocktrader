import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { findAsset } from "../../assets";
import { fetchQuote } from "../../marketData";
import { easternParts, easternTime, isTradingDay, nextTradingDay } from "../../../marketHours";
import { lockAccount } from "./positions";
import { postActivity } from "./transfers";
import { isRoundLot } from "./margin";
import { hardToBorrow, marginSnapshot } from "./marginAccount";
import type { CreateLocateRequest, ListLocateQuotesResponse, ListLocatesResponse, Locate } from "../types";

// Locates for hard-to-borrow short sales, as Alpaca's /v1/locates works: a short sale of a hard-to-borrow stock needs an active locate
// for its shares first; locates come in round lots of 100, last until 8:00 p.m. ET on their trading day, are used up by the shorts they cover
// (covering doesn't give them back) and cost a fee per share, charged when granted and not refunded. Quotes are advisory. The fee and
// availability are simulated: SIM_LOCATE_FEE_RATE of the price per share (default 0.1%, at least a cent) and SIM_LOCATE_AVAILABLE
// shares (default 10,000) of each symbol a day.

const FEE_RATE = Number(process.env.SIM_LOCATE_FEE_RATE ?? 0.001);
const AVAILABLE = Number(process.env.SIM_LOCATE_AVAILABLE ?? 10000);

type Db = PoolClient | typeof pool;

interface LocateRow {
    id: string; account_id: string; symbol: string; requested_qty: number; located_qty: number | null; located_price: string | null;
    total_fee: string | null; limit_price: string | null; all_or_none: boolean; status: "active" | "expired" | "rejected";
    rejection_reason: string | null; used_qty: string; created_at: Date; expires_at: Date | null;
}

const decimal = (value: string | null, places: number) => value === null ? null : Number(value).toFixed(places);

const toLocate = (row: LocateRow, now = new Date()): Locate => ({
    id: row.id, symbol: row.symbol, requested_qty: row.requested_qty, located_qty: row.located_qty, located_price: decimal(row.located_price, 4),
    total_fee: decimal(row.total_fee, 2), limit_price: decimal(row.limit_price, 4), all_or_none: row.all_or_none,
    // An active locate expires at the end of its day
    status: row.status === "active" && row.expires_at && row.expires_at <= now ? "expired" : row.status,
    ...(row.rejection_reason ? { rejection_reason: row.rejection_reason } : {}),
    created_at: row.created_at.toISOString(), expires_at: row.expires_at?.toISOString() ?? null
});

// The simulated locate fee per share for a stock at a price
export const locateFee = (price: number) => Math.max(0.01, Math.round(price * FEE_RATE * 1e4) / 1e4);

// Shares of the symbol already located today by any account (the day's inventory is shared)
const locatedToday = async (db: Db, symbol: string, now: Date) => {
    const day = easternParts(now).dateKey;
    const { rows: [row] } = await db.query<{ qty: string }>(
        `SELECT COALESCE(SUM(located_qty), 0) AS qty FROM sim_locates WHERE symbol = $1 AND status = 'active' AND created_at >= $2`, [symbol, easternTime(day, "00:00")]
    );
    return Number(row.qty);
};

// GET /v1/locates/quotes?symbols=: the fee and shares available for each hard-to-borrow symbol (easy-to-borrow ones need no locate)
export const listLocateQuotes = async (accountId: string, symbols: string[]): Promise<ListLocateQuotesResponse> => {
    const response: ListLocateQuotesResponse = { quotes: [], errors: [] };
    const now = new Date();
    for (const raw of [...new Set(symbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 100)) {
        const asset = await findAsset(raw);
        if (asset === null) {
            response.errors!.push({ code: "symbol_not_found", message: "symbol not found", symbol: raw });
        } else if (!hardToBorrow(raw, asset)) {
            response.errors!.push({ code: "easy_to_borrow", message: `${raw} is easy to borrow; no locate is needed`, symbol: raw });
        } else {
            const quote = await fetchQuote(raw).catch(() => null);
            if (!quote) {
                response.errors!.push({ code: "quote_unavailable", message: "no current price to quote a locate", symbol: raw });
                continue;
            }
            const available = Math.max(0, AVAILABLE - await locatedToday(pool, raw, now));
            response.quotes.push({ symbol: raw, available_qty: available, ...(available > 0 ? { price: locateFee(quote.price).toFixed(4) } : {}), quoted_at: now.toISOString() });
        }
    }
    return response;
};

// POST /v1/locates: a locate for a round lot of a hard-to-borrow stock, granted for what's available (all of it with all_or_none, or
// rejected) at a fee no higher than limit_price, which is charged at once as a FEE activity. Needs an account that may short and the
// buying power for the fee.
export const createLocate = async (accountId: string, request: Partial<CreateLocateRequest> | null): Promise<Locate> => {
    const symbol = String(request?.symbol ?? "").trim().toUpperCase();
    const qty = Number(request?.qty);
    if (!symbol) throw new BrokerError(400, 40010001, "symbol is required");
    if (!isRoundLot(qty)) throw new BrokerError(400, 40010001, "qty must be a positive round lot of 100 shares");
    const limit = request?.limit_price === undefined || request.limit_price === null ? null : Number(request.limit_price);
    if (limit !== null && !(limit > 0)) throw new BrokerError(400, 40010001, "limit_price must be a positive fee per share");
    const asset = await findAsset(symbol);
    if (asset === null) throw new BrokerError(422, 40010001, `security not found: ${symbol}`);
    if (!hardToBorrow(symbol, asset)) throw new BrokerError(422, 40010001, `${symbol} is easy to borrow; no locate is needed`);
    const quote = await fetchQuote(symbol);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await lockAccount(client, accountId);
        const snapshot = await marginSnapshot(client, accountId);
        if (snapshot.shortingBlocked) throw new BrokerError(403, 40310000, snapshot.shortingBlocked);
        const now = new Date();
        const price = locateFee(quote.price);
        const available = Math.max(0, AVAILABLE - await locatedToday(client, symbol, now));
        const located = Math.min(qty, Math.floor(available / 100) * 100);
        const reject = limit !== null && price > limit ? "price_above_limit" : located === 0 || (request?.all_or_none && located < qty) ? "inventory_unavailable" : null;
        const fee = Math.round(located * price * 100) / 100;
        if (!reject && fee > snapshot.state.buyingPower + 0.005) throw new BrokerError(422, 40310000, `insufficient buying power for the $${fee.toFixed(2)} locate fee`);
        const id = randomUUID();
        // Good until 8:00 p.m. ET on the day it's for: today's trading day, or the next one once today's sessions are over
        const today = easternParts(now).dateKey;
        const day = isTradingDay(today) && now < easternTime(today, "20:00") ? today : nextTradingDay(today);
        const expiresAt = easternTime(day, "20:00");
        const activity = reject ? null : await postActivity(client, { accountId, type: "FEE", netAmount: -fee, description: `Locate fee: ${located} ${symbol} at $${price.toFixed(4)}`, symbol, qty: located, at: now });
        const { rows: [row] } = await client.query<LocateRow>(
            `INSERT INTO sim_locates (id, account_id, symbol, requested_qty, located_qty, located_price, total_fee, limit_price, all_or_none, status, rejection_reason, fee_activity_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [id, accountId, symbol, qty, reject ? null : located, reject ? null : price, reject ? null : fee, limit, request?.all_or_none === true,
                reject ? "rejected" : "active", reject, activity?.id ?? null, now, reject ? null : expiresAt]
        );
        await client.query("COMMIT");
        return toLocate(row, now);
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
};

// GET /v1/locates: newest first, by status (active, expired, rejected) and symbol
export const listLocates = async (accountId: string, query: { status?: string; symbol?: string; limit?: number } = {}): Promise<ListLocatesResponse> => {
    const { rows } = await pool.query<LocateRow>(
        "SELECT * FROM sim_locates WHERE account_id = $1 AND ($2::text IS NULL OR symbol = $2) ORDER BY created_at DESC, id DESC LIMIT $3",
        [accountId, query.symbol?.toUpperCase() ?? null, Math.min(500, Math.max(1, Number(query.limit ?? 100) || 100))]
    );
    const now = new Date();
    const locates = rows.map(row => toLocate(row, now)).filter(locate => !query.status || locate.status === query.status);
    return { locates, next_page_token: null };
};

export const getLocate = async (accountId: string, locateId: string): Promise<Locate> => {
    if (!/^[0-9a-f-]{36}$/i.test(locateId)) throw new BrokerError(404, 40410000, "locate not found");
    const { rows: [row] } = await pool.query<LocateRow>("SELECT * FROM sim_locates WHERE id = $1 AND account_id = $2", [locateId, accountId]);
    if (!row) throw new BrokerError(404, 40410000, "locate not found");
    return toLocate(row);
};

// Located shares of the symbol still unused today
export const locatedShares = async (db: Db, accountId: string, symbol: string, now = new Date()): Promise<number> => {
    const { rows: [row] } = await db.query<{ left: string }>(
        `SELECT COALESCE(SUM(located_qty - used_qty), 0) AS left FROM sim_locates WHERE account_id = $1 AND symbol = $2 AND status = 'active' AND expires_at > $3`,
        [accountId, symbol, now]
    );
    return Number(row.left);
};

// Uses up located shares for a short sale's fill, oldest locates first
export const consumeLocates = async (db: PoolClient, accountId: string, symbol: string, qty: number, now = new Date()) => {
    const { rows } = await db.query<LocateRow>(
        `SELECT * FROM sim_locates WHERE account_id = $1 AND symbol = $2 AND status = 'active' AND expires_at > $3 AND located_qty > used_qty ORDER BY created_at FOR UPDATE`,
        [accountId, symbol, now]
    );
    let left = qty;
    for (const row of rows) {
        if (left <= 0) break;
        const use = Math.min(left, Number(row.located_qty) - Number(row.used_qty));
        await db.query("UPDATE sim_locates SET used_qty = used_qty + $2 WHERE id = $1", [row.id, use]);
        left -= use;
    }
    return qty - left;
};
