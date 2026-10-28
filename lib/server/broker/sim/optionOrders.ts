import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { fetchOptionContract, fetchPrices } from "../../marketData";
import { roundCents } from "../../account";
import { easternTime } from "../../../marketHours";
import { OPTIONS_LEVELS, parseOptionSymbol } from "../../../options";
import { ledgerState, recordFill } from "./positions";
import { marginSnapshot } from "./marginAccount";
import { applyReplace, orderExpiry, type OrderSpec } from "./orderRules";
import {
    legOpens, mlegCoverageError, mlegNetPrice, OPTION_MULTIPLIER, requiredLevel, sharesCoveringCalls, totalOptionRequirement, validateOptionOrder,
    type OptionHolding, type OptionLeg
} from "./options";
import {
    endOrder, getOrder, insertOrder, marketContext, matchOrders, OPEN, orderEvent, orderRow, requireUniqueClientId, toSpec, tradingAccount, updateOrder, withAccountTx, WORKING
} from "./orders";
import { tradesIn, type MatchContext } from "./matching";
import type { SimOrderRow } from "./shapes";
import type { CreateOrderRequest, Order, OrderSide, OrderType, PositionIntent, TimeInForce, UpdateOrderRequest } from "../types";
import type { FillPolicy, Quote } from "../../../types";

// Option orders in the simulator (Alpaca's options trading): single-leg orders on a contract and mleg orders of 2 to 4 legs, checked
// with ./options.ts's rules (order terms, the level each needs, an mleg order's coverage), against options buying power (the order's
// cost: the requirement it adds under the universal spread rule plus any debit, at its limit or the quotes), and held back from buying
// power while open (buying_power_held). Single-leg orders then go through the order engine like stock orders (./orders.ts); an mleg
// order fills all its legs together, each at its own bid or ask, when its net price is within its limit (positive a debit, negative a
// credit). Quantities are contracts; prices are per share, × 100 in dollars.

const LABEL = "Sim options";
const invalid = (message: string) => new BrokerError(422, 40010001, message);
const forbidden = (message: string) => new BrokerError(403, 40310000, message);
const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (value: string | null): number | null => value === null ? null : Number(value);
const INTENTS: PositionIntent[] = ["buy_to_open", "buy_to_close", "sell_to_open", "sell_to_close"];

// An option order request with its numbers parsed; a single-leg order is one leg of ratio 1
export interface OptionOrderSpec {
    mleg: boolean;
    // The contract (an mleg parent has none)
    symbol: string;
    side: OrderSide;
    type: OrderType;
    timeInForce: TimeInForce;
    qty: number | null;
    notional: number | null;
    // An mleg order's net limit: positive a debit, negative a credit
    limitPrice: number | null;
    stopPrice: number | null;
    extendedHours: boolean;
    positionIntent: PositionIntent | null;
    clientOrderId: string | null;
    legs: OptionLeg[];
}

const parseNumber = (value: unknown, field: string, { signed = false }: { signed?: boolean } = {}): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const number = typeof value === "number" ? value : typeof value === "string" && /^\s*-?\d*\.?\d+\s*$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || (!signed && number <= 0) || number === 0) throw invalid(`${field} must be a ${signed ? "non-zero" : "positive"} number`);
    return number;
};

export const parseOptionRequest = (request: Partial<CreateOrderRequest> & { legs?: unknown }): OptionOrderSpec => {
    const mleg = request.order_class === "mleg";
    if (!mleg && request.order_class && request.order_class !== "simple") throw invalid("option orders are simple or mleg orders");
    const intent = (value: unknown, field: string): PositionIntent | null => {
        if (value === undefined || value === null || value === "") return null;
        if (!INTENTS.includes(value as PositionIntent)) throw invalid(`invalid ${field} ${String(value)}`);
        return value as PositionIntent;
    };
    const clientOrderId = request.client_order_id ? String(request.client_order_id) : null;
    if (clientOrderId !== null && clientOrderId.length > 128) throw invalid("client_order_id must be at most 128 characters");
    let legs: OptionLeg[];
    let side: OrderSide;
    if (mleg) {
        if (!Array.isArray(request.legs)) throw invalid("legs are required for mleg orders");
        legs = request.legs.map((leg: Record<string, unknown>, index) => {
            const positionIntent = intent(leg?.position_intent, `legs[${index}].position_intent`);
            const legSide = leg?.side ?? positionIntent?.split("_")[0];
            if (legSide !== "buy" && legSide !== "sell") throw invalid(`legs[${index}].side must be buy or sell`);
            return { symbol: String(leg?.symbol ?? "").trim().toUpperCase(), side: legSide, ratio: parseNumber(leg?.ratio_qty ?? 1, `legs[${index}].ratio_qty`) ?? 1, positionIntent };
        });
        side = "buy";
    } else {
        if (request.side !== "buy" && request.side !== "sell") throw invalid("side must be buy or sell");
        side = request.side;
        legs = [{ symbol: String(request.symbol ?? "").trim().toUpperCase(), side, ratio: 1, positionIntent: intent(request.position_intent, "position_intent") }];
    }
    return {
        mleg, symbol: mleg ? "" : legs[0].symbol, side, type: request.type as OrderType, timeInForce: request.time_in_force as TimeInForce,
        qty: parseNumber(request.qty, "qty"), notional: parseNumber(request.notional, "notional"),
        limitPrice: parseNumber(request.limit_price, "limit_price", { signed: mleg }), stopPrice: parseNumber(request.stop_price, "stop_price"),
        extendedHours: request.extended_hours === true, positionIntent: mleg ? null : legs[0].positionIntent, clientOrderId, legs
    };
};

// The positions after legs fill qty units
const applyLegs = (positions: { symbol: string; qty: number }[], legs: Pick<OptionLeg, "symbol" | "side" | "ratio">[], qty: number) => {
    const after = new Map(positions.map(({ symbol, qty: held }) => [symbol, held]));
    for (const leg of legs) after.set(leg.symbol, (after.get(leg.symbol) ?? 0) + (leg.side === "buy" ? 1 : -1) * leg.ratio * qty);
    return [...after].map(([symbol, held]) => ({ symbol, qty: held }));
};

// What an order costs in options buying power: the option requirement it adds plus its net debit (less a credit) at netPrice per unit
export const optionOrderCost = (positions: { symbol: string; qty: number }[], legs: Pick<OptionLeg, "symbol" | "side" | "ratio">[], qty: number, netPrice: number): number =>
    roundCents(totalOptionRequirement(applyLegs(positions, legs, qty)) - totalOptionRequirement(positions) + netPrice * OPTION_MULTIPLIER * qty);

const positionsOf = (ledger: Awaited<ReturnType<typeof ledgerState>>) => ledger.positions.map(({ ticker, quantity }) => ({ symbol: ticker, qty: quantity }));

// The contracts open orders already hold of a position on its closing side (single-leg orders and mleg legs)
const heldByOrders = async (db: PoolClient, accountId: string, symbol: string, side: OrderSide, exceptIds: string[]) => {
    const { rows: [row] } = await db.query<{ qty: string }>(
        `SELECT COALESCE(SUM(qty - filled_qty), 0) AS qty FROM sim_orders WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = ANY($4) AND NOT (id = ANY($5::uuid[]))`,
        [accountId, symbol, side, OPEN, exceptIds]
    );
    return Number(row.qty);
};

// Checks what an option order does to the account (its legs against the positions, the level it needs, options buying power) and
// returns what it holds back: the requirement it adds plus its debit, or null for an order that only closes
const checkAgainstAccount = async (db: PoolClient, accountId: string, spec: OptionOrderSpec, netPrice: number, exceptIds: string[] = []): Promise<number | null> => {
    const account = await tradingAccount(db, accountId);
    const level = Math.min(account.options_approved_level ?? 0, Number(account.configurations?.max_options_trading_level ?? 0));
    const ledger = await ledgerState(db, accountId);
    const positionOf = (symbol: string) => ledger.positions.find(({ ticker }) => ticker === symbol)?.quantity ?? 0;
    const qty = spec.qty!;
    const legs = spec.legs.map(leg => ({ ...leg, opens: legOpens(leg, positionOf(leg.symbol)) }));
    for (const leg of legs) {
        const position = positionOf(leg.symbol);
        const closesSide = leg.side === "sell" ? position > 0 : position < 0;
        if (leg.opens && closesSide) {
            throw forbidden(`position_intent ${leg.positionIntent} would trade against the open ${position > 0 ? "long" : "short"} ${leg.symbol} position; close it first`);
        }
        if (!leg.opens) {
            if (!closesSide) throw forbidden(`insufficient qty available for order (requested: ${leg.ratio * qty}, available: 0)`);
            const available = Math.abs(position) - await heldByOrders(db, accountId, leg.symbol, leg.side, exceptIds);
            if (leg.ratio * qty > available + 1e-9) throw forbidden(`insufficient qty available for order (requested: ${leg.ratio * qty}, available: ${Math.max(0, available)})`);
        }
    }
    if (spec.mleg) {
        const coverage = mlegCoverageError(legs);
        if (coverage) throw forbidden(coverage);
    }
    const underlying = parseOptionSymbol(legs[0].symbol)!.underlying;
    const holdings: OptionHolding[] = ledger.positions.flatMap(({ ticker, quantity }) => {
        const contract = parseOptionSymbol(ticker);
        return contract && contract.underlying === underlying ? [{ ...contract, qty: quantity }] : [];
    });
    const needed = requiredLevel(legs, { holdings, longShares: Math.max(0, positionOf(underlying)), mleg: spec.mleg });
    if (needed > level) {
        throw forbidden(level === 0
            ? "options trading isn't enabled for this account: request an options level in Settings"
            : `this order needs options ${OPTIONS_LEVELS[needed].toLowerCase()}; the account trades at level ${level}`);
    }
    if (!legs.some(({ opens }) => opens)) return null;
    const snapshot = await marginSnapshot(db, accountId, { exceptOrderIds: exceptIds });
    if (snapshot.calls.length > 0) {
        const total = snapshot.calls.reduce((sum, call) => sum + Number(call.amount), 0);
        throw forbidden(`account has an open ${money(total)} margin call: only closing orders are allowed until it's met`);
    }
    const cost = optionOrderCost(positionsOf(snapshot.ledger), spec.legs, qty, netPrice);
    if (!Number.isFinite(cost)) throw forbidden("the order would leave short calls uncovered");
    const available = snapshot.state.nonMarginableBuyingPower;
    if (cost > available + 0.005) {
        throw forbidden(`insufficient options buying power: the order needs ${money(cost)}, but ${money(available)} is available${snapshot.reserved > 0 ? ` (${money(snapshot.reserved)} is held for open orders)` : ""}`);
    }
    return Math.max(0, cost);
};

// The net price per unit an order is checked at: its limit (or stop), else the quotes (asks for buys, bids for sells), signed: a debit
// positive, a credit negative
const netPriceOf = (spec: OptionOrderSpec, quotes: { bid: number; ask: number }[]): number => {
    if (spec.mleg) return spec.limitPrice ?? mlegNetPrice(spec.legs, quotes);
    const price = spec.limitPrice ?? spec.stopPrice ?? (spec.side === "buy" ? quotes[0].ask : quotes[0].bid);
    return spec.side === "buy" ? price : -price;
};

const quoteSides = (quote: Pick<Quote, "price" | "bid" | "ask">) => ({ bid: quote.bid ?? quote.price, ask: quote.ask ?? quote.price });

// When an option order stops working: its time in force's expiry, but no later than its contracts' expiration (the close that day)
const optionExpiry = (spec: OptionOrderSpec, now: Date): Date => {
    const byTif = orderExpiry({ timeInForce: spec.timeInForce, extendedHours: false }, now);
    const expirations = spec.legs.map(({ symbol }) => easternTime(parseOptionSymbol(symbol)!.expiration, "16:00").getTime());
    return new Date(Math.min(byTif.getTime(), ...expirations));
};

// POST /v1/trading/accounts/{id}/orders for an option contract or an mleg order: checked, stored new (accepted outside the regular
// session) with its legs, then matched at once
export const createOptionOrder = async (accountId: string, request: CreateOrderRequest, { liquidation = false }: { liquidation?: boolean } = {}): Promise<Order> => {
    const spec = parseOptionRequest(request as CreateOrderRequest & { legs?: unknown });
    const now = new Date();
    validateOptionOrder({ ...spec, qty: spec.qty, legs: spec.legs }, now);
    const contracts = await Promise.all(spec.legs.map(({ symbol }) => fetchOptionContract(symbol, now)));
    const missing = spec.legs.find((_, index) => !contracts[index]);
    if (missing) throw invalid(`asset ${missing.symbol} not found: it isn't a listed contract`);
    const quotes = contracts.map(found => ({ bid: found!.contract.quote.bid, ask: found!.contract.quote.ask }));
    const netPrice = netPriceOf(spec, quotes);
    const id = await withAccountTx(accountId, async db => {
        await requireUniqueClientId(db, accountId, spec.clientOrderId);
        const held = await checkAgainstAccount(db, accountId, spec, netPrice);
        const status = tradesIn({ extendedHours: false, timeInForce: spec.timeInForce }, (await marketContext()).session) ? "new" : "accepted";
        const expiresAt = optionExpiry(spec, now);
        const base: OrderSpec = {
            symbol: spec.symbol, side: spec.mleg ? (netPrice >= 0 ? "buy" : "sell") : spec.side, type: spec.type, timeInForce: spec.timeInForce,
            orderClass: spec.mleg ? "mleg" as OrderSpec["orderClass"] : "simple", positionIntent: spec.positionIntent, qty: spec.qty, notional: null,
            limitPrice: spec.limitPrice, stopPrice: spec.stopPrice, trailPrice: null, trailPercent: null, extendedHours: false, takeProfit: null, stopLoss: null,
            clientOrderId: spec.clientOrderId
        };
        const groupId = spec.mleg ? randomUUID() : null;
        const parent = await insertOrder(db, accountId, { spec: base, status, groupId, expiresAt, liquidation, buyingPowerHeld: held });
        if (spec.mleg) {
            for (const leg of spec.legs) {
                await insertOrder(db, accountId, {
                    spec: { ...base, symbol: leg.symbol, side: leg.side, positionIntent: leg.positionIntent, qty: leg.ratio * spec.qty!, type: "market", limitPrice: null, stopPrice: null, clientOrderId: null },
                    status, parentId: parent.id, groupId, groupRole: "leg", expiresAt, ratioQty: leg.ratio
                });
            }
        }
        await orderEvent(db, parent, status);
        return parent.id;
    });
    await matchOrders({ accountId, orderIds: [id] }).catch(error => console.error(`${LABEL}: matching ${id}: ${error.message}`));
    return getOrder(accountId, id);
};

// A single-leg option order about to fill qty contracts at price: it must still fit options buying power (without its own hold)
export const checkOptionFill = async (db: PoolClient, row: SimOrderRow, qty: number, price: number) => {
    const spec: OptionOrderSpec = {
        mleg: false, symbol: row.symbol, side: row.side, type: row.type, timeInForce: row.time_in_force, qty, notional: null, limitPrice: price, stopPrice: null,
        extendedHours: false, positionIntent: row.position_intent ?? null, clientOrderId: null, legs: [{ symbol: row.symbol, side: row.side, ratio: 1, positionIntent: row.position_intent ?? null }]
    };
    await checkAgainstAccount(db, row.account_id, spec, row.side === "buy" ? price : -price, [row.id]);
};

// Ends an mleg order and its legs together
const endMleg = async (db: PoolClient, parent: SimOrderRow, legs: SimOrderRow[], status: "expired" | "canceled", reason: string) => {
    for (const leg of legs) await updateOrder(db, leg.id, { status, reason, [status === "expired" ? "expired_at" : "canceled_at"]: new Date() });
    await endOrder(db, parent, status, reason);
};

// One tick of an mleg order: it activates when the regular session opens, expires at its time, and fills every leg at once (each at
// its ask or bid) when the net price is within its limit; a closing leg whose position is gone, or an opening order that no longer
// fits options buying power, cancels it. Returns whether it changed.
export const matchMlegOrder = async (parentId: string, accountId: string, context: Omit<MatchContext, "now">): Promise<boolean> => {
    const { rows: legSymbols } = await pool.query<{ symbol: string }>("SELECT symbol FROM sim_orders WHERE parent_id = $1 AND group_role = 'leg'", [parentId]);
    const symbols = legSymbols.map(({ symbol }) => symbol);
    const priced = context.session === "regular" && symbols.length > 0 ? await fetchPrices(symbols, LABEL) : { quotes: {} as Record<string, Quote>, staleTickers: symbols };
    return withAccountTx(accountId, async db => {
        const { rows: [parent] } = await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE id = $1 FOR UPDATE", [parentId]);
        if (!parent || !WORKING.includes(parent.status)) return false;
        const { rows: legs } = await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE parent_id = $1 AND group_role = 'leg' ORDER BY created_at, id FOR UPDATE", [parentId]);
        const now = new Date();
        if (now >= parent.expires_at) {
            await endMleg(db, parent, legs, "expired", parent.time_in_force === "day" ? "The day order expired at the close" : "The order expired");
            return true;
        }
        if (context.session !== "regular") return false;
        let changed = false;
        let order = parent;
        if (parent.status === "accepted") {
            order = await updateOrder(db, parent.id, { status: "new" });
            for (const leg of legs) await updateOrder(db, leg.id, { status: "new" });
            await orderEvent(db, order, "new");
            changed = true;
        }
        const quotes = legs.map(leg => priced.staleTickers.includes(leg.symbol) ? null : priced.quotes[leg.symbol] ?? null);
        if (quotes.some(quote => quote === null)) return changed;
        const sides = quotes.map(quote => quoteSides(quote!));
        const legSpecs = legs.map(leg => ({ symbol: leg.symbol, side: leg.side, ratio: leg.ratio_qty ?? 1, positionIntent: leg.position_intent ?? null }));
        const net = mlegNetPrice(legSpecs, sides);
        const limit = num(order.limit_price);
        if (order.type === "limit" && limit !== null && net > limit + 1e-9) return changed;
        const qty = Number(order.qty);
        const spec: OptionOrderSpec = {
            mleg: true, symbol: "", side: order.side, type: order.type, timeInForce: order.time_in_force, qty, notional: null, limitPrice: net, stopPrice: null,
            extendedHours: false, positionIntent: null, clientOrderId: null, legs: legSpecs
        };
        try {
            await checkAgainstAccount(db, accountId, spec, net, [order.id, ...legs.map(({ id }) => id)]);
        } catch (error) {
            if (!(error instanceof BrokerError)) throw error;
            await endMleg(db, order, legs, "canceled", error.message);
            return true;
        }
        for (const [index, leg] of legs.entries()) {
            const legQty = (leg.ratio_qty ?? 1) * qty;
            const quote = quotes[index]!;
            const price = leg.side === "buy" ? sides[index].ask : sides[index].bid;
            if (!(price > 0)) {
                await endMleg(db, order, legs, "canceled", `${leg.symbol} has no ${leg.side === "buy" ? "ask" : "bid"} to fill against`);
                return true;
            }
            const total = roundCents(legQty * price * OPTION_MULTIPLIER);
            const policy: FillPolicy = quote.spread === "quoted" ? (leg.side === "buy" ? "ASK" : "BID") : (leg.side === "buy" ? "SIM_ASK" : "SIM_BID");
            await recordFill(db, accountId, { symbol: leg.symbol, side: leg.side, qty: legQty, price, total, quoteTime: quote.quoteTime, fillPolicy: policy, orderId: leg.id, cumQty: legQty, leavesQty: 0 });
            await updateOrder(db, leg.id, { status: "filled", filled_qty: legQty, filled_notional: total, filled_avg_price: price.toFixed(6), filled_at: now });
        }
        const filled = await updateOrder(db, order.id, { status: "filled", filled_qty: qty, filled_notional: roundCents(Math.abs(net) * qty * OPTION_MULTIPLIER), filled_avg_price: net.toFixed(6), filled_at: now });
        await orderEvent(db, filled, "fill", { price: String(net), qty: String(qty) });
        return true;
    });
};

// PATCH an option order (single-leg): the replace rules for stocks, then the option rules and a fresh options buying power check
export const replaceOptionOrder = async (accountId: string, orderId: string, update: UpdateOrderRequest): Promise<Order> => {
    const now = new Date();
    const original = await orderRow(pool, accountId, orderId);
    const found = await fetchOptionContract(original.symbol, now);
    if (!found) throw invalid(`asset ${original.symbol} not found: it isn't a listed contract`);
    const id = await withAccountTx(accountId, async db => {
        const current = await orderRow(db, accountId, orderId, true);
        if (!["new", "accepted", "partially_filled"].includes(current.status)) throw invalid(`order is already in "${current.status}" state`);
        const replaced = applyReplace(toSpec(current), update, Number(current.filled_qty));
        await requireUniqueClientId(db, accountId, replaced.clientOrderId);
        const spec: OptionOrderSpec = {
            mleg: false, symbol: current.symbol, side: current.side, type: replaced.type, timeInForce: replaced.timeInForce, qty: replaced.qty, notional: null,
            limitPrice: replaced.limitPrice, stopPrice: replaced.stopPrice, extendedHours: false, positionIntent: replaced.positionIntent, clientOrderId: replaced.clientOrderId,
            legs: [{ symbol: current.symbol, side: current.side, ratio: 1, positionIntent: replaced.positionIntent }]
        };
        validateOptionOrder(spec, now);
        const held = await checkAgainstAccount(db, accountId, spec, netPriceOf(spec, [{ bid: found.contract.quote.bid, ask: found.contract.quote.ask }]), [current.id]);
        const pending = await updateOrder(db, current.id, { status: "pending_replace" });
        await orderEvent(db, pending, "pending_replace");
        const replacement = await insertOrder(db, accountId, {
            spec: replaced, status: current.status === "partially_filled" ? "new" : current.status, replaces: current.id, buyingPowerHeld: held,
            expiresAt: replaced.timeInForce === current.time_in_force ? current.expires_at : optionExpiry(spec, now)
        });
        const ended = await updateOrder(db, current.id, { status: "replaced", replaced_by: replacement.id, replaced_at: now });
        await orderEvent(db, ended, "replaced");
        await orderEvent(db, replacement, replacement.status);
        return replacement.id;
    });
    await matchOrders({ accountId, orderIds: [id] }).catch(error => console.error(`${LABEL}: matching ${id}: ${error.message}`));
    return getOrder(accountId, id);
};

// The long shares of a stock that cover the account's short calls on it (they can't be sold while they do)
export const sharesCoveringCallsIn = async (db: PoolClient | typeof pool, accountId: string, underlying: string): Promise<number> => {
    const { rows } = await db.query<{ symbol: string; side: "long" | "short"; qty: string }>(
        "SELECT symbol, side, SUM(qty) AS qty FROM sim_lots WHERE account_id = $1 AND qty > 0 AND symbol LIKE $2 GROUP BY symbol, side", [accountId, `${underlying.toUpperCase()}%`]
    );
    const holdings = rows.flatMap(({ symbol, side, qty }) => {
        const contract = parseOptionSymbol(symbol);
        return contract && contract.underlying === underlying.toUpperCase() ? [{ ...contract, qty: side === "long" ? Number(qty) : -Number(qty) }] : [];
    });
    return sharesCoveringCalls(holdings);
};

