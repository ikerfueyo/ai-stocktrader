import "server-only";
import type { PoolClient } from "pg";
import { fetchPrices } from "./marketData";
import { assessTrade, computePositions, reducesPosition } from "./account";
import { evaluateOrder, reservedForOrders, toOpenOrder, type Evaluation, type OpenOrder } from "./orderMatching";
import { getMarketStatus } from "./market";
import { loadCorporateActions } from "./corporateActions";
import { getAccount, inTransaction, insertTrade, shortTickers, type Db } from "./portfolio";
import { easternParts, marketStatus, sessionOn, type MarketStatus } from "../marketHours";
import { toOrder } from "../orders";
import type { OrderRow, Position, Quote } from "../types";

export const getOpenOrders = async (userId: string, db: Db): Promise<OrderRow[]> =>
    (await db.query<OrderRow>(`SELECT * FROM orders WHERE user_id = $1 AND status = 'OPEN' ORDER BY created_at, id`, [userId])).rows;

// When a DAY order placed now expires: the close of the current session, or of the next one once today's has passed (or the
// market is closed all day). The first session close after now, whatever MARKET_HOURS_OVERRIDE says.
export const dayOrderExpiry = (market: MarketStatus, now = new Date()): Date => {
    if (market.open && market.nextClose) return new Date(market.nextClose);
    const today = sessionOn(easternParts(now).dateKey);
    if (today && today.close > now) return today.close;
    return sessionOn(easternParts(new Date(marketStatus(now).nextOpen)).dateKey)!.close;
};

// The cash held back for open orders (reservedForOrders), excluding exceptId. Orders without a limit or stop price (queued market
// orders) are priced at their ticker's current price.
export const reservedCashFor = async (orders: OrderRow[], positions: Position[], label: string, exceptId?: number): Promise<number> => {
    const open = orders.filter(({ id }) => id !== exceptId).map(toOpenOrder);
    const unpriced = [...new Set(open.filter(order => order.limitPrice === null && order.stopPrice === null && order.quantity !== null).map(({ ticker }) => ticker))];
    const { prices } = unpriced.length > 0 ? await fetchPrices(unpriced, label) : { prices: {} };
    return reservedForOrders(open, positions, prices);
};

const setStatus = (db: Db, id: number, status: OrderRow["status"], reason: string) =>
    db.query(`UPDATE orders SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 AND status = 'OPEN'`, [id, status, reason.slice(0, 500)]);

// Fills an order that evaluateOrder found marketable, through the same checks as a market order: a fill that opens or adds to a
// position must leave no collateral shortfall, with the cash reserved for the user's other open orders unavailable. A close-only
// order is capped at the position now open on its closing side. A fill that isn't allowed rejects the order with the reason. The
// market is checked again right before the fill, since the checks can wait on quotes.
const fillOrder = async (userId: string, order: OpenOrder, fill: Extract<Evaluation, { action: "fill" }>, quote: Quote, db: PoolClient, label: string) => {
    const { transactions, splits, netTransfers, positions } = await getAccount(userId, db);
    const held = positions.find(({ ticker }) => ticker === order.ticker)?.quantity ?? 0;
    const closable = order.side === "SELL" ? Math.max(held, 0) : Math.max(-held, 0);
    if (order.closeOnly && closable === 0) {
        await setStatus(db, order.id, "REJECTED", `There's no ${order.ticker} position left to close`);
        return null;
    }
    const { quantity, total } = toOrder({
        mode: order.amount !== null ? "dollars" : "shares",
        value: order.amount ?? order.quantity!,
        price: fill.price,
        maxShares: order.closeOnly ? closable : Infinity
    });
    if (!(quantity > 0)) {
        await setStatus(db, order.id, "REJECTED", "The order is too small to fill");
        return null;
    }
    const trade = { type: order.side, ticker: order.ticker, price: fill.price, quantity, total };
    if (!reducesPosition({ positions, trade })) {
        const reservedCash = await reservedCashFor(await getOpenOrders(userId, db), positions, label, order.id);
        const { positions: after } = computePositions([...transactions, trade], splits);
        const { prices, staleTickers } = await fetchPrices(shortTickers(after).filter(symbol => symbol !== order.ticker), label);
        const assessment = assessTrade({ transactions, splits, netTransfers, prices, staleTickers, trade, reservedCash });
        if (!assessment.allowed) {
            // A missing short price only delays the fill
            if (assessment.status !== 502) await setStatus(db, order.id, "REJECTED", assessment.message);
            return null;
        }
    }
    if ((order.expiresAt && new Date() >= order.expiresAt) || !(await getMarketStatus()).open) return null;
    return inTransaction(db, async () => {
        const row = await insertTrade(db, userId, { ...trade, fillPolicy: fill.fillPolicy, quoteTime: quote.quoteTime, orderId: order.id });
        await db.query(
            `UPDATE orders SET status = 'FILLED', triggered_at = COALESCE(triggered_at, CASE WHEN $2 THEN now() END), updated_at = now() WHERE id = $1`,
            [order.id, fill.triggered]
        );
        return row;
    });
};

const recordTrigger = (db: Db, id: number) =>
    db.query(`UPDATE orders SET triggered_at = COALESCE(triggered_at, now()), updated_at = now() WHERE id = $1`, [id]);

// Checks a user's open orders against current quotes (evaluateOrder), oldest first: fills the marketable ones, records stop
// triggers (even when the fill itself has to wait), and expires DAY orders past their close. An order placed before a split of its
// ticker is cancelled, since its quantity and prices are in the old shares. Quotes are only fetched while the
// market is open, and a quote too old to trade on (isStaleQuote) counts as none. Each order is judged at the time and market status
// after the quotes arrive, so nothing fills past its expiry or the close. Call it inside withAccountLock with its client. Returns
// how many orders changed.
export const matchOrders = async (userId: string, label: string, db: PoolClient): Promise<number> => {
    const rows = await getOpenOrders(userId, db);
    if (rows.length === 0) return 0;
    let changed = 0;
    const { splits } = await loadCorporateActions([...new Set(rows.map(({ ticker }) => ticker.toUpperCase()))]);
    const today = easternParts(new Date()).dateKey;
    const orders: OpenOrder[] = [];
    for (const row of rows) {
        const order = toOpenOrder(row);
        const placed = easternParts(new Date(row.created_at)).dateKey;
        const split = splits.find(({ ticker, exDate }) => ticker === order.ticker && exDate > placed && exDate <= today);
        if (!split) {
            orders.push(order);
            continue;
        }
        await setStatus(db, order.id, "CANCELLED", `Cancelled for the ${order.ticker} stock split on ${split.exDate}`);
        changed++;
    }
    const { quotes, staleTickers } = (await getMarketStatus()).open
        ? await fetchPrices([...new Set(orders.map(({ ticker }) => ticker))], label)
        : { quotes: {} as Record<string, Quote>, staleTickers: [] as string[] };
    for (const order of orders) {
        const quote = staleTickers.includes(order.ticker) ? null : quotes[order.ticker] ?? null;
        const evaluation = evaluateOrder(order, quote, { now: new Date(), marketOpen: (await getMarketStatus()).open });
        if (evaluation.action === "expire") {
            await setStatus(db, order.id, "EXPIRED", evaluation.reason);
        } else if (evaluation.action === "trigger") {
            await recordTrigger(db, order.id);
        } else if (evaluation.action === "fill") {
            const filled = await fillOrder(userId, order, evaluation, quote!, db, label);
            if (filled) console.log(`${label}: filled order ${order.id} for ${userId}: ${order.side} ${parseFloat(filled.quantity)} ${order.ticker} @ ${filled.price}`);
            else if (evaluation.triggered) await recordTrigger(db, order.id);
        } else {
            continue;
        }
        changed++;
    }
    return changed;
};
