import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { UpstreamError } from "../../httpError";
import { findAsset } from "../../assets";
import { fetchPrices, fetchQuote } from "../../marketData";
import type { AssetRow } from "../../universe";
import { getMarketStatus } from "../../market";
import { reducesPosition, roundCents } from "../../account";
import { easternParts, sessionOn } from "../../../marketHours";
import { emitEvent } from "./accounts";
import { ledgerState, listFills, lockAccount, positionQty, recordFill } from "./positions";
import { buyingPowerCost } from "./margin";
import { hardToBorrow, marginSnapshot, OPEN_ORDER_STATUSES } from "./marginAccount";
import { locatedShares, consumeLocates } from "./locates";
import { applyReplace, orderExpiry, parseOrderRequest, validateOrder, type OpenOrderSummary, type OrderSpec } from "./orderRules";
import { evaluateOrder, reservationPrice, trailingStop, tradesIn, type LiveOrder, type MatchContext, type MatchFill, type Session } from "./matching";
import { toOrder, type SimOrderRow } from "./shapes";
import type { CreateOrderRequest, ListOrdersQuery, Order, UpdateOrderRequest } from "../types";
import type { Quote } from "../../../types";

// The simulator's order engine: Alpaca's order endpoints on sim_orders. Orders are checked (./orderRules.ts) and against the account's
// margin (./marginAccount.ts) when placed, then matched on every tick of the sim-orders job and right after they're
// placed or replaced (./matching.ts): fills post through the ledger (recordFill), bracket and OTO legs go live when their entry fills,
// OCO legs cancel each other, and every change emits a trades event in Alpaca's trade_updates shape. Each account's changes run in
// a transaction holding its advisory lock (lockAccount), so the job, the routes and buy-ins don't interleave.

const LABEL = "Sim orders";
// Orders still working: matched on each tick (held legs wait for their entry)
const WORKING = ["new", "accepted", "partially_filled"];
const OPEN = [...WORKING, "held", "pending_new", "pending_cancel", "pending_replace"];
const CLOSED = ["filled", "canceled", "expired", "replaced", "rejected", "done_for_day"];
const LIQUIDITY_SHARE = Number(process.env.SIM_LIQUIDITY_SHARE ?? 0.1);

const num = (value: string | null): number | null => value === null ? null : Number(value);
const notFound = () => new BrokerError(404, 40410000, "order not found");
// Shares from a dollar amount, rounded down to the 6 decimals the ledger keeps (Alpaca allows 9), so the order and its lots agree
const sharesFor = (notional: number, price: number) => Math.floor(notional / price * 1e6 + 1e-6) / 1e6;

const withAccountTx = async <T>(accountId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await lockAccount(client, accountId);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
};

const toLive = (row: SimOrderRow): LiveOrder => ({
    id: row.id, side: row.side, type: row.type, timeInForce: row.time_in_force, status: row.status,
    qty: num(row.qty), notional: num(row.notional), filledQty: Number(row.filled_qty), filledNotional: Number(row.filled_notional),
    limitPrice: num(row.limit_price), stopPrice: num(row.stop_price), trailPrice: num(row.trail_price), trailPercent: num(row.trail_percent),
    hwm: num(row.hwm), extendedHours: row.extended_hours, triggered: row.stop_triggered_at !== null, expiresAt: row.expires_at
});

const toSpec = (row: SimOrderRow): OrderSpec => ({
    symbol: row.symbol, side: row.side, type: row.type, timeInForce: row.time_in_force, orderClass: row.order_class, positionIntent: row.position_intent ?? null,
    qty: num(row.qty), notional: num(row.notional), limitPrice: num(row.limit_price), stopPrice: num(row.stop_price), trailPrice: num(row.trail_price),
    trailPercent: num(row.trail_percent), extendedHours: row.extended_hours, takeProfit: null, stopLoss: null, clientOrderId: row.client_order_id
});

const summarize = (row: SimOrderRow): OpenOrderSummary => ({
    id: row.id, side: row.side, type: row.type, limitPrice: num(row.limit_price),
    remainingQty: row.qty === null ? null : Number(row.qty) - Number(row.filled_qty),
    notionalLeft: row.notional === null ? null : Number(row.notional) - Number(row.filled_notional),
    groupId: row.group_id, held: row.status === "held"
});

const assetIdFor = async (symbol: string) => (await findAsset(symbol))?.alpacaId ?? undefined;

// A trade_updates event for the order (Alpaca's TradeUpdateEventV2), on the trades stream
const orderEvent = async (db: PoolClient, row: SimOrderRow, event: string, extra: Record<string, unknown> = {}) => {
    const at = new Date();
    await emitEvent(row.account_id, "trades", { account_id: row.account_id, event, order: toOrder(row), timestamp: at.toISOString(), ...extra }, at, db);
};

const updateOrder = async (db: PoolClient, id: string, fields: Record<string, unknown>): Promise<SimOrderRow> => {
    const keys = Object.keys(fields);
    const { rows: [row] } = await db.query<SimOrderRow>(
        `UPDATE sim_orders SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...keys.map(key => fields[key])]
    );
    return row;
};

const marketContext = async (): Promise<Omit<MatchContext, "now">> => {
    const market = await getMarketStatus();
    const today = sessionOn(easternParts(new Date()).dateKey);
    return { session: market.session as Session, regularOpen: today?.open ?? null, regularClose: today?.close ?? null, liquidityShare: LIQUIDITY_SHARE };
};

// The trading account's state, or the BrokerError Alpaca answers an account that can't trade with
const tradingAccount = async (db: PoolClient, accountId: string) => {
    const { rows: [row] } = await db.query<{ status: string; configurations: { fractional_trading?: boolean; no_shorting?: boolean; suspend_trade?: boolean }; trading_blocked: boolean; account_blocked: boolean }>(
        "SELECT status, configurations, trading_blocked, account_blocked FROM sim_accounts WHERE id = $1", [accountId]
    );
    if (!row) throw new BrokerError(404, 40410000, "account not found");
    if (!["ACTIVE", "ACCOUNT_UPDATED"].includes(row.status) || row.trading_blocked || row.account_blocked || row.configurations?.suspend_trade) {
        throw new BrokerError(403, 40310000, "account is not authorized to trade");
    }
    return row;
};

const openOrdersIn = async (db: PoolClient, accountId: string, symbol: string) =>
    (await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE account_id = $1 AND symbol = $2 AND status = ANY($3)", [accountId, symbol, OPEN])).rows;

// Whether an order that opens or adds to a position fits the account's margin (./marginAccount.ts), as Alpaca checks it: not during
// an open margin call, a short only where shorting is allowed, and the order's buying power cost (its value, twice that for a
// non-marginable stock on margin) within the buying power the other open orders leave. Throws 403 like Alpaca's "insufficient buying
// power", or 502 when a short's price is missing. price is what the order is checked at: its reservation price when placed, the fill
// price when it fills. Closing orders always pass.
const checkBuyingPower = async (db: PoolClient, accountId: string, order: { symbol: string; side: "buy" | "sell"; qty: number | null; notional: number | null }, price: number, exceptIds: string[], asset?: AssetRow | null) => {
    const snapshot = await marginSnapshot(db, accountId, { exceptOrderIds: exceptIds });
    const quantity = order.qty ?? order.notional! / price;
    const trade = { type: order.side === "buy" ? "BUY" : "SELL", ticker: order.symbol, price, quantity, total: roundCents(order.notional ?? quantity * price) } as const;
    if (reducesPosition({ positions: snapshot.ledger.positions, trade })) return;
    const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (snapshot.calls.length > 0) {
        const total = snapshot.calls.reduce((sum, call) => sum + Number(call.amount), 0);
        throw new BrokerError(403, 40310000, `account has an open ${money(total)} margin call: only closing orders are allowed until it's met`);
    }
    if (order.side === "sell" && snapshot.shortingBlocked) throw new BrokerError(403, 40310000, snapshot.shortingBlocked);
    const unpriced = snapshot.positions.filter(({ symbol, qty }) => qty < 0 && symbol !== order.symbol && snapshot.staleTickers.includes(symbol)).map(({ symbol }) => symbol);
    if (unpriced.length > 0) throw new UpstreamError(`Couldn't get a current price for ${unpriced.join(", ")} to check margin; try again shortly`);
    const marginable = (snapshot.assets[order.symbol] ?? asset ?? (await findAsset(order.symbol)) ?? null)?.marginable ?? null;
    const cost = buyingPowerCost(roundCents(order.notional ?? quantity * price), { marginable, multiplier: snapshot.state.multiplier });
    if (cost > snapshot.state.buyingPower + 0.005) {
        const what = order.side === "buy" ? `buying ${order.symbol}` : `shorting ${order.symbol}`;
        throw new BrokerError(403, 40310000, `insufficient buying power: ${what} needs ${money(cost)}, but ${money(snapshot.state.buyingPower)} is available${snapshot.reserved > 0 ? ` (${money(snapshot.reserved)} is held for open orders)` : ""}`);
    }
};

// A short sale of a hard-to-borrow stock needs located shares not already spoken for by the account's other open short sales in it
const requireLocate = async (db: PoolClient, accountId: string, symbol: string, qty: number, exceptId?: string) => {
    const { rows: [row] } = await db.query<{ qty: string }>(
        `SELECT COALESCE(SUM(qty - filled_qty), 0) AS qty FROM sim_orders WHERE account_id = $1 AND symbol = $2 AND side = 'sell' AND status = ANY($3) AND id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')`,
        [accountId, symbol, OPEN_ORDER_STATUSES, exceptId ?? null]
    );
    const available = await locatedShares(db, accountId, symbol) - Number(row.qty);
    if (qty > available + 1e-9) {
        throw new BrokerError(403, 40310000, `${symbol} is hard to borrow: locate the shares before shorting it (${Math.max(0, available)} located and unused, ${qty} needed)`);
    }
};

interface NewOrder {
    spec: OrderSpec;
    status: string;
    parentId?: string | null;
    groupId?: string | null;
    groupRole?: SimOrderRow["group_role"];
    replaces?: string | null;
    hwm?: number | null;
    expiresAt: Date;
    liquidation?: boolean;
}

const insertOrder = async (db: PoolClient, accountId: string, { spec, status, parentId = null, groupId = null, groupRole = null, replaces = null, hwm = null, expiresAt, liquidation = false }: NewOrder) => {
    const { rows: [row] } = await db.query<SimOrderRow>(
        `INSERT INTO sim_orders (id, account_id, client_order_id, symbol, side, "type", time_in_force, order_class, position_intent, qty, notional, limit_price,
                                 stop_price, trail_price, trail_percent, hwm, extended_hours, status, parent_id, group_id, group_role, replaces, expires_at, liquidation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING *`,
        [randomUUID(), accountId, spec.clientOrderId ?? randomUUID(), spec.symbol, spec.side, spec.type, spec.timeInForce, spec.orderClass, spec.positionIntent,
            spec.qty, spec.notional, spec.limitPrice, spec.stopPrice, spec.trailPrice, spec.trailPercent, hwm, spec.extendedHours, status, parentId, groupId, groupRole,
            replaces, expiresAt, liquidation]
    );
    return row;
};

const requireUniqueClientId = async (db: PoolClient, accountId: string, clientOrderId: string | null) => {
    if (!clientOrderId) return;
    const { rowCount } = await db.query("SELECT 1 FROM sim_orders WHERE account_id = $1 AND client_order_id = $2", [accountId, clientOrderId]);
    if (rowCount) throw new BrokerError(422, 40010001, "client_order_id must be unique");
};

// POST /v1/trading/accounts/{id}/orders. Checked, stored new (or accepted, outside the session it trades in), with any bracket, OTO or
// OCO legs, then matched at once, so a marketable order comes back filled. liquidation marks the simulator's own orders that meet a
// margin call (their fills are LIQUIDATION).
export const createOrder = async (accountId: string, request: CreateOrderRequest, { liquidation = false }: { liquidation?: boolean } = {}): Promise<Order> => {
    const spec = parseOrderRequest(request);
    // An OCO order's own limit is its take profit
    if (spec.orderClass === "oco" && spec.takeProfit) spec.limitPrice = spec.takeProfit.limitPrice;
    const asset = await findAsset(spec.symbol);
    if (asset === null) throw new BrokerError(422, 40010001, `asset ${spec.symbol} not found`);
    const quote = await fetchQuote(spec.symbol);
    const market = await marketContext();
    const id = await withAccountTx(accountId, async db => {
        const account = await tradingAccount(db, accountId);
        await requireUniqueClientId(db, accountId, spec.clientOrderId);
        const now = new Date();
        const position = await positionQty(db, accountId, spec.symbol);
        validateOrder(spec, {
            now, price: quote.price, position, openOrders: (await openOrdersIn(db, accountId, spec.symbol)).map(summarize), configurations: account.configurations ?? {},
            asset: asset ? { tradable: asset.tradable, fractionable: asset.fractionable, shortable: asset.shortable, attributes: asset.attributes } : null
        });
        if (spec.side === "sell" && position <= 0 && hardToBorrow(spec.symbol, asset)) await requireLocate(db, accountId, spec.symbol, spec.qty ?? 0);
        await checkBuyingPower(db, accountId, spec, reservationPrice(spec, quote) ?? quote.price, [], asset);
        const live = tradesIn(spec, market.session) && spec.timeInForce !== "opg";
        const expiresAt = orderExpiry(spec, now);
        const groupId = spec.orderClass === "simple" ? null : randomUUID();
        const hwm = spec.type === "trailing_stop" ? quote.price : null;
        if (hwm !== null) spec.stopPrice = trailingStop(spec, hwm);
        const parent = await insertOrder(db, accountId, {
            spec, status: live ? "new" : "accepted", groupId, hwm, expiresAt, liquidation,
            groupRole: spec.orderClass === "simple" ? null : spec.orderClass === "oco" ? "take_profit" : "entry"
        });
        await orderEvent(db, parent, parent.status);
        const ids = [parent.id];
        // Legs: the exits, on the other side (an OCO's stop loss is on the same side as its take profit), held until a bracket or OTO
        // entry fills, live at once for an OCO
        const legSide = spec.orderClass === "oco" ? spec.side : spec.side === "buy" ? "sell" : "buy";
        const leg = (overrides: Partial<OrderSpec>): OrderSpec => ({
            ...spec, side: legSide, positionIntent: null, notional: null, trailPrice: null, trailPercent: null, takeProfit: null, stopLoss: null, clientOrderId: null,
            limitPrice: null, stopPrice: null, ...overrides
        });
        const legs: { spec: OrderSpec; role: "take_profit" | "stop_loss" }[] = [];
        if (spec.takeProfit && spec.orderClass !== "oco") legs.push({ spec: leg({ type: "limit", limitPrice: spec.takeProfit.limitPrice }), role: "take_profit" });
        if (spec.stopLoss) {
            const { stopPrice, limitPrice } = spec.stopLoss;
            legs.push({ spec: leg({ type: limitPrice === null ? "stop" : "stop_limit", stopPrice, limitPrice }), role: "stop_loss" });
        }
        for (const { spec: legSpec, role } of legs) {
            const status = spec.orderClass === "oco" ? parent.status : "held";
            const row = await insertOrder(db, accountId, { spec: legSpec, status, parentId: parent.id, groupId, groupRole: role, expiresAt });
            if (status !== "held") {
                await orderEvent(db, row, status);
                ids.push(row.id);
            }
        }
        return ids;
    });
    await matchOrders({ accountId, orderIds: id }).catch(error => console.error(`${LABEL}: matching ${id[0]}: ${error.message}`));
    return getOrder(accountId, id[0]);
};

const orderRow = async (db: PoolClient | typeof pool, accountId: string, orderId: string, forUpdate = false) => {
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw notFound();
    const { rows: [row] } = await db.query<SimOrderRow>(`SELECT * FROM sim_orders WHERE id = $1 AND account_id = $2${forUpdate ? " FOR UPDATE" : ""}`, [orderId, accountId]);
    if (!row) throw notFound();
    return row;
};

const withLegs = async (row: SimOrderRow): Promise<Order> => {
    const { rows: legs } = await pool.query<SimOrderRow>("SELECT * FROM sim_orders WHERE parent_id = $1 ORDER BY group_role DESC, created_at", [row.id]);
    return toOrder(row, { legs, assetId: await assetIdFor(row.symbol) });
};

// GET /v1/trading/accounts/{id}/orders/{order_id}, with its legs
export const getOrder = async (accountId: string, orderId: string): Promise<Order> => withLegs(await orderRow(pool, accountId, orderId));

// GET /v1/trading/accounts/{id}/orders:by_client_order_id
export const getOrderByClientOrderId = async (accountId: string, clientOrderId: string): Promise<Order> => {
    const { rows: [row] } = await pool.query<SimOrderRow>("SELECT * FROM sim_orders WHERE account_id = $1 AND client_order_id = $2", [accountId, clientOrderId]);
    if (!row) throw notFound();
    return withLegs(row);
};

// GET /v1/trading/accounts/{id}/orders: open orders by default (closed or all), newest first (direction asc for oldest), up to
// limit (default 50, at most 500), submitted after or until a time, in the symbols asked for. nested puts the legs under their
// parent instead of listing them on their own, and lists a parent whose legs match the status (a filled entry with working exits).
export const listOrders = async (accountId: string, query: ListOrdersQuery & { side?: "buy" | "sell" } = {}): Promise<Order[]> => {
    const statuses = query.status === "closed" ? CLOSED : query.status === "all" ? [...OPEN, ...CLOSED] : OPEN;
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 50) || 50));
    const symbols = query.symbols ? String(query.symbols).split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean) : null;
    const nested = String(query.nested) === "true";
    const { rows } = await pool.query<SimOrderRow>(
        `SELECT * FROM sim_orders o WHERE account_id = $1 AND ($3::text[] IS NULL OR symbol = ANY($3))
           AND ($4::timestamptz IS NULL OR submitted_at > $4) AND ($5::timestamptz IS NULL OR submitted_at < $5) AND ($6::text IS NULL OR side = $6)
           AND (status = ANY($2) OR ($7 AND EXISTS (SELECT 1 FROM sim_orders l WHERE l.parent_id = o.id AND l.status = ANY($2))))
           AND (NOT $7 OR parent_id IS NULL)
         ORDER BY submitted_at ${query.direction === "asc" ? "ASC" : "DESC"}, id LIMIT $8`,
        [accountId, statuses, symbols, query.after ?? null, query.until ?? null, query.side ?? null, nested, limit]
    );
    const legs = nested && rows.length > 0
        ? (await pool.query<SimOrderRow>("SELECT * FROM sim_orders WHERE parent_id = ANY($1) ORDER BY group_role DESC, created_at", [rows.map(({ id }) => id)])).rows
        : [];
    const assetIds = new Map(await Promise.all([...new Set(rows.map(({ symbol }) => symbol))].map(async symbol => [symbol, await assetIdFor(symbol)] as const)));
    return rows.map(row => toOrder(row, { legs: nested ? legs.filter(leg => leg.parent_id === row.id) : undefined, assetId: assetIds.get(row.symbol) }));
};

// The fills of an order (and of the orders it replaced), newest first, with their realized P&L and settlement dates
export const listOrderFills = async (accountId: string, orderId: string) => {
    const ids: string[] = [];
    let row: SimOrderRow | null = await orderRow(pool, accountId, orderId);
    while (row) {
        ids.push(row.id);
        row = row.replaces ? await orderRow(pool, accountId, row.replaces).catch(() => null) : null;
    }
    return listFills(pool, accountId, { orderIds: ids });
};

// Ends an order (expired, canceled or rejected) with the reason (none for a cancel the user asked for), and settles its legs: an entry that filled at least in part sends
// its legs live for what it filled; one that filled nothing cancels them
const endOrder = async (db: PoolClient, row: SimOrderRow, status: "expired" | "canceled" | "rejected", reason: string | null): Promise<SimOrderRow> => {
    const timestamp = status === "expired" ? "expired_at" : status === "canceled" ? "canceled_at" : "failed_at";
    const ended = await updateOrder(db, row.id, { status, reason: reason?.slice(0, 500) ?? null, [timestamp]: new Date() });
    await orderEvent(db, ended, status, { reason });
    if (ended.group_role === "entry") {
        const filled = Number(ended.filled_qty);
        if (filled > 0) await activateLegs(db, ended, filled);
        else for (const leg of await heldLegs(db, ended.id)) await endOrder(db, leg, "canceled", "Its entry order didn't fill");
    }
    return ended;
};

const heldLegs = async (db: PoolClient, parentId: string) =>
    (await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE parent_id = $1 AND status = 'held'", [parentId])).rows;

// A bracket or OTO entry has filled: its legs go live for the shares it filled
const activateLegs = async (db: PoolClient, entry: SimOrderRow, qty: number) => {
    const { session } = await marketContext();
    for (const leg of await heldLegs(db, entry.id)) {
        const live = await updateOrder(db, leg.id, { status: tradesIn({ extendedHours: leg.extended_hours, timeInForce: leg.time_in_force }, session) ? "new" : "accepted", qty, submitted_at: new Date() });
        await orderEvent(db, live, live.status);
    }
};

// An exit leg (a bracket's or OTO's, or either side of an OCO) filled: the other legs of its group shrink by the same shares, and
// end once nothing is left of them (one cancels the other)
const settleSiblings = async (db: PoolClient, row: SimOrderRow, qty: number) => {
    if (!row.group_id || row.group_role === "entry") return;
    const { rows: siblings } = await db.query<SimOrderRow>(
        "SELECT * FROM sim_orders WHERE group_id = $1 AND id <> $2 AND group_role <> 'entry' AND status = ANY($3) FOR UPDATE", [row.group_id, row.id, OPEN]
    );
    for (const sibling of siblings) {
        const left = Number(sibling.qty ?? 0) - qty;
        if (left <= Number(sibling.filled_qty) + 1e-9) await endOrder(db, sibling, "canceled", `The other leg (${row.group_role?.replace("_", " ")}) filled`);
        else await updateOrder(db, sibling.id, { qty: left });
    }
};

// Fills (part of) an order on this tick: a close and an exit leg are capped at the position on their closing side (cancelled when
// there's none left), so no order goes through zero; a fill that opens or adds to a position must still fit the buying power, or the
// order is cancelled with the reason (a missing short price only delays it). Returns the order after the fill, or null if it didn't.
const fillOrder = async (db: PoolClient, row: SimOrderRow, fill: MatchFill, quote: Quote): Promise<SimOrderRow | null> => {
    const position = await positionQty(db, row.account_id, row.symbol);
    const closable = row.side === "sell" ? Math.max(position, 0) : Math.max(-position, 0);
    const exit = row.position_intent?.endsWith("_to_close") || (row.group_role !== null && row.group_role !== "entry");
    let qty = fill.qty ?? sharesFor(fill.notional!, fill.price);
    let capped = false;
    if (exit && closable <= 1e-9) {
        await endOrder(db, row, "canceled", `There's no ${row.symbol} position left to close`);
        return null;
    }
    if (closable > 1e-9 && qty > closable + 1e-9) {
        qty = closable;
        capped = true;
    }
    const total = roundCents(qty * fill.price);
    if (!(qty > 0) || total < 0.01) {
        await endOrder(db, row, "canceled", "The order is too small to fill");
        return null;
    }
    const trade = { type: row.side === "buy" ? "BUY" : "SELL", ticker: row.symbol, price: fill.price, quantity: qty, total } as const;
    const ledger = await ledgerState(db, row.account_id);
    if (!reducesPosition({ positions: ledger.positions, trade })) {
        try {
            await checkBuyingPower(db, row.account_id, { symbol: row.symbol, side: row.side, qty, notional: null }, fill.price, [row.id]);
        } catch (error) {
            if (!(error instanceof BrokerError)) return null;
            await endOrder(db, row, "canceled", error.message);
            return null;
        }
    }
    // A short sale of a hard-to-borrow stock uses up its locate
    if (row.side === "sell" && position <= 0 && hardToBorrow(row.symbol, await findAsset(row.symbol))) {
        const used = await consumeLocates(db, row.account_id, row.symbol, qty);
        if (used < qty - 1e-9) {
            await endOrder(db, row, "canceled", `${row.symbol} is hard to borrow and its locate is used up or expired`);
            return null;
        }
    }
    const cumQty = Number(row.filled_qty) + qty;
    const complete = row.notional !== null || capped || cumQty >= Number(row.qty) - 1e-9;
    const leavesQty = complete ? 0 : Number(row.qty) - cumQty;
    const activity = await recordFill(db, row.account_id, {
        symbol: row.symbol, side: row.side, qty, price: fill.price, total, quoteTime: quote.quoteTime, fillPolicy: fill.fillPolicy, orderId: row.id, cumQty, leavesQty,
        reason: row.liquidation ? "LIQUIDATION" : undefined
    });
    const filledNotional = roundCents(Number(row.filled_notional) + total);
    const now = new Date();
    const updated = await updateOrder(db, row.id, {
        status: complete ? "filled" : "partially_filled", filled_qty: cumQty, filled_notional: filledNotional,
        filled_avg_price: (filledNotional / cumQty).toFixed(6), ...(complete ? { filled_at: now } : {}),
        // A notional order's shares are known once it fills; a capped close fills what was left of the position
        ...(row.notional === null && capped ? { qty: cumQty } : {})
    });
    await orderEvent(db, updated, complete ? "fill" : "partial_fill", {
        execution_id: activity.id, price: String(fill.price), qty: String(qty), position_qty: String(await positionQty(db, row.account_id, row.symbol)),
        settle_date: activity.settle_date
    });
    if (complete && updated.group_role === "entry") await activateLegs(db, updated, cumQty);
    await settleSiblings(db, updated, qty);
    return updated;
};

// Cancels the orders placed before a split of their symbol took effect, since their shares and prices are in the old terms
// (Alpaca adjusts some GTC orders instead; Phase 6)
const splitSince = async (symbols: string[]) => {
    const today = easternParts(new Date()).dateKey;
    const { rows } = await pool.query<{ ticker: string; ex_date: string }>(
        `SELECT ticker, ex_date::text FROM corporate_actions WHERE "type" = 'SPLIT' AND ticker = ANY($1) AND ex_date <= $2`, [symbols, today]
    );
    return (row: SimOrderRow) => rows.find(({ ticker, ex_date }) => ticker === row.symbol && ex_date > easternParts(row.created_at).dateKey)?.ex_date ?? null;
};

// One order on one tick (evaluateOrder), applied in the account's transaction on the order as it is now
const matchOne = async (orderId: string, accountId: string, quote: Quote | null, context: Omit<MatchContext, "now">, split: string | null): Promise<boolean> =>
    withAccountTx(accountId, async db => {
        const { rows: [row] } = await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE id = $1 FOR UPDATE", [orderId]);
        if (!row || !WORKING.includes(row.status)) return false;
        if (split) {
            await endOrder(db, row, "canceled", `Cancelled for the ${row.symbol} stock split on ${split}`);
            return true;
        }
        const result = evaluateOrder(toLive(row), quote, { ...context, now: new Date() });
        let order = row;
        let changed = false;
        if (result.activate) {
            order = await updateOrder(db, order.id, { status: "new" });
            await orderEvent(db, order, "new");
            changed = true;
        }
        if (result.hwm !== undefined || result.triggered) {
            order = await updateOrder(db, order.id, {
                ...(result.hwm !== undefined ? { hwm: result.hwm, stop_price: result.stopPrice } : {}),
                ...(result.triggered ? { stop_triggered_at: new Date() } : {})
            });
            changed = true;
        }
        if (result.fill && quote) {
            const filled = await fillOrder(db, order, result.fill, quote);
            if (!filled) return true;
            order = filled;
            changed = true;
        }
        if (result.end && WORKING.includes(order.status)) {
            await endOrder(db, order, result.end.status, result.end.reason);
            changed = true;
        }
        return changed;
    });

// The order engine's tick (the sim-orders job, and right after an order is placed or replaced): every working order, or one
// account's, or the ones asked for, oldest first, against current quotes (fetched once for all; none overnight, when only expiries
// can happen). A quote too old to trade on (isStaleQuote) counts as none. Returns how many orders changed.
export const matchOrders = async ({ accountId, orderIds }: { accountId?: string; orderIds?: string[] } = {}): Promise<number> => {
    const { rows } = await pool.query<SimOrderRow>(
        `SELECT * FROM sim_orders WHERE status = ANY($1) AND ($2::uuid IS NULL OR account_id = $2) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY created_at, id`,
        [WORKING, accountId ?? null, orderIds ?? null]
    );
    if (rows.length === 0) return 0;
    const context = await marketContext();
    const symbols = [...new Set(rows.map(({ symbol }) => symbol))];
    const needsQuotes = context.session !== "closed" || rows.some(({ time_in_force }) => time_in_force === "cls");
    const { quotes, staleTickers } = needsQuotes ? await fetchPrices(symbols, LABEL) : { quotes: {} as Record<string, Quote>, staleTickers: [] as string[] };
    const splitOf = await splitSince(symbols);
    let changed = 0;
    for (const row of rows) {
        const quote = staleTickers.includes(row.symbol) ? null : quotes[row.symbol] ?? null;
        try {
            if (await matchOne(row.id, row.account_id, quote, context, splitOf(row))) changed++;
        } catch (error) {
            console.error(`${LABEL}: ${row.id} (${row.side} ${row.symbol}): ${error instanceof Error ? error.message : error}`);
        }
    }
    return changed;
};

// DELETE /v1/trading/accounts/{id}/orders/{order_id}: through pending_cancel to canceled. Cancelling any order of a bracket, OCO or
// OTO cancels the group's other open orders too (a partly filled entry sends its legs live for what it filled instead).
export const cancelOrder = async (accountId: string, orderId: string): Promise<void> => {
    await withAccountTx(accountId, async db => {
        const row = await orderRow(db, accountId, orderId, true);
        if (!OPEN.includes(row.status)) throw new BrokerError(422, 40010001, `order is already in "${row.status}" state`);
        await cancelWithGroup(db, row);
    });
};

const cancelWithGroup = async (db: PoolClient, row: SimOrderRow) => {
    const requested = await updateOrder(db, row.id, { status: "pending_cancel", cancel_requested_at: new Date() });
    await orderEvent(db, requested, "pending_cancel");
    await endOrder(db, requested, "canceled", null);
    if (row.group_id && row.group_role !== "entry") {
        const { rows: others } = await db.query<SimOrderRow>(
            "SELECT * FROM sim_orders WHERE group_id = $1 AND id <> $2 AND status = ANY($3) FOR UPDATE", [row.group_id, row.id, OPEN]
        );
        for (const other of others) await endOrder(db, other, "canceled", "Its group was cancelled");
    }
};

// DELETE /v1/trading/accounts/{id}/orders: every open order, answered per order as Alpaca does
export const cancelAllOrders = async (accountId: string): Promise<{ id: string; status: number }[]> => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM sim_orders WHERE account_id = $1 AND status = ANY($2) ORDER BY parent_id NULLS FIRST, created_at", [accountId, OPEN]);
    const results: { id: string; status: number }[] = [];
    for (const { id } of rows) {
        const cancelled = await withAccountTx(accountId, async db => {
            const row = await orderRow(db, accountId, id, true);
            if (!OPEN.includes(row.status)) return false;
            await cancelWithGroup(db, row);
            return true;
        });
        if (cancelled) results.push({ id, status: 200 });
    }
    return results;
};

// PATCH /v1/trading/accounts/{id}/orders/{order_id}: a new order with the changes, which replaces the old one (replaced, linked both
// ways); checked like a new order, with the old one's reservation released. Legs follow a replaced entry.
export const replaceOrder = async (accountId: string, orderId: string, update: UpdateOrderRequest): Promise<Order> => {
    const original = await orderRow(pool, accountId, orderId);
    const asset = await findAsset(original.symbol);
    const quote = await fetchQuote(original.symbol);
    const id = await withAccountTx(accountId, async db => {
        const current = await orderRow(db, accountId, orderId, true);
        if (!["new", "accepted", "held", "partially_filled"].includes(current.status)) throw new BrokerError(422, 40010001, `order is already in "${current.status}" state`);
        const account = await tradingAccount(db, accountId);
        const spec = applyReplace(toSpec(current), update, Number(current.filled_qty));
        await requireUniqueClientId(db, accountId, spec.clientOrderId);
        const position = await positionQty(db, accountId, current.symbol);
        const others = (await openOrdersIn(db, accountId, current.symbol)).filter(({ id: other }) => other !== current.id).map(summarize);
        validateOrder(spec, {
            now: new Date(), price: quote.price, position, openOrders: others, configurations: account.configurations ?? {},
            asset: asset ? { tradable: asset.tradable, fractionable: asset.fractionable, shortable: asset.shortable, attributes: asset.attributes } : null
        }, { groupId: current.group_id, replacing: true });
        const closing = current.side === "sell" ? position > 0 : position < 0;
        if (closing && current.status !== "held") {
            const available = Math.abs(position) - others.filter(order => order.side === current.side && !order.held && order.groupId !== current.group_id).reduce((sum, order) => sum + (order.remainingQty ?? 0), 0);
            if (spec.qty! > available + 1e-9) throw new BrokerError(403, 40310000, `insufficient qty available for order (requested: ${spec.qty}, available: ${parseFloat(available.toFixed(9))})`);
        }
        if (current.status !== "held") await checkBuyingPower(db, accountId, spec, reservationPrice(spec, quote) ?? quote.price, [current.id], asset);
        if (spec.side === "sell" && position <= 0 && current.status !== "held" && hardToBorrow(current.symbol, asset)) await requireLocate(db, accountId, current.symbol, spec.qty ?? 0, current.id);
        const hwm = num(current.hwm);
        if (spec.type === "trailing_stop" && hwm !== null) spec.stopPrice = trailingStop(spec, hwm);
        const pending = await updateOrder(db, current.id, { status: "pending_replace" });
        await orderEvent(db, pending, "pending_replace");
        const replacement = await insertOrder(db, accountId, {
            spec, status: current.status, parentId: current.parent_id, groupId: current.group_id, groupRole: current.group_role, replaces: current.id, hwm,
            expiresAt: spec.timeInForce === current.time_in_force ? current.expires_at : orderExpiry(spec, new Date())
        });
        await db.query("UPDATE sim_orders SET parent_id = $2 WHERE parent_id = $1", [current.id, replacement.id]);
        const replaced = await updateOrder(db, current.id, { status: "replaced", replaced_by: replacement.id, replaced_at: new Date() });
        await orderEvent(db, replaced, "replaced");
        if (replacement.status !== "held") await orderEvent(db, replacement, replacement.status);
        return replacement.id;
    });
    await matchOrders({ accountId, orderIds: [id] }).catch(error => console.error(`${LABEL}: matching ${id}: ${error.message}`));
    return getOrder(accountId, id);
};

// DELETE /v1/trading/accounts/{id}/positions/{symbol}: a day market order closing the position, or qty shares or percentage of it
export const closePosition = async (accountId: string, symbol: string, size: { qty?: string; percentage?: string } = {}): Promise<Order> => {
    const ticker = symbol.toUpperCase();
    const { rows: [lot] } = await pool.query("SELECT 1 FROM sim_lots WHERE account_id = $1 AND symbol = $2 AND qty > 0 LIMIT 1", [accountId, ticker]);
    if (!lot) throw new BrokerError(404, 40410000, "position not found");
    const position = await positionQty(pool, accountId, ticker);
    const held = Math.abs(position);
    const qty = size.qty !== undefined ? Number(size.qty) : size.percentage !== undefined ? Math.floor(held * Number(size.percentage) / 100 * 1e9) / 1e9 : held;
    if (!(qty > 0) || qty > held + 1e-9) throw new BrokerError(422, 40010001, `qty must be more than 0 and at most the position (${held})`);
    return createOrder(accountId, {
        symbol: ticker, side: position > 0 ? "sell" : "buy", type: "market", time_in_force: "day", qty: String(qty),
        position_intent: position > 0 ? "sell_to_close" : "buy_to_close"
    });
};

// Why each order ended (rejected, cancelled, expired), as its trade event's reason gives it, for the pages
export const orderReasons = async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const { rows } = await pool.query<{ id: string; reason: string }>("SELECT id, reason FROM sim_orders WHERE id = ANY($1) AND reason IS NOT NULL", [ids]);
    return new Map(rows.map(({ id, reason }) => [id, reason]));
};

// How many orders of the account are still open (an account can't close with any)
export const openOrderCount = async (accountId: string): Promise<number> =>
    Number((await pool.query<{ count: string }>("SELECT count(*) FROM sim_orders WHERE account_id = $1 AND status = ANY($2)", [accountId, OPEN])).rows[0].count);

