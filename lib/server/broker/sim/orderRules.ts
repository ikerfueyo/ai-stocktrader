// Alpaca's order rules for U.S. equities: what a CreateOrderRequest (or a replace) may ask for, checked before an order is accepted,
// and when an accepted order expires. Pure, so it can be unit tested; ./orders.ts runs it with the account's position, open orders
// and the current price, then checks buying power. Rejections are BrokerErrors with Alpaca's statuses and codes: 422 (40010001) for
// an invalid request, 422 (42210000) for a price off its tick size, 403 (40310000) for what the account can't do (insufficient qty
// available, a potential wash trade, shorting where it isn't allowed).
import { BrokerError } from "../errors";
import { addDays, easternParts, easternTime, isTradingDay, nextTradingDay, sessionOn } from "../../../marketHours";
import type { CreateOrderRequest, OrderClass, OrderSide, OrderType, PositionIntent, TimeInForce, UpdateOrderRequest } from "../types";

export type SimOrderClass = Exclude<OrderClass, "mleg" | "">;

// An order request with its decimals parsed
export interface OrderSpec {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    timeInForce: TimeInForce;
    orderClass: SimOrderClass;
    positionIntent: PositionIntent | null;
    qty: number | null;
    notional: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
    trailPrice: number | null;
    trailPercent: number | null;
    extendedHours: boolean;
    takeProfit: { limitPrice: number } | null;
    stopLoss: { stopPrice: number; limitPrice: number | null } | null;
    clientOrderId: string | null;
}

// An open order of the account, as the rules need it
export interface OpenOrderSummary {
    id: string;
    side: OrderSide;
    type: OrderType;
    limitPrice: number | null;
    // Shares still to fill (null for a notional order, valued at notionalLeft)
    remainingQty: number | null;
    notionalLeft: number | null;
    groupId: string | null;
    // A bracket or OTO leg waiting for its entry to fill
    held: boolean;
}

export interface OrderContext {
    now: Date;
    // The asset's flags (null fields when Alpaca's aren't known); null when the universe hasn't been synced
    asset: { tradable: boolean | null; fractionable: boolean | null; shortable: boolean | null; attributes: string[] } | null;
    // The last price, for the bracket base price and for valuing notional orders
    price: number | null;
    // The signed position held in the symbol (negative for a short)
    position: number;
    // The account's other open orders in the symbol
    openOrders: OpenOrderSummary[];
    configurations: { fractional_trading?: boolean; no_shorting?: boolean };
}

const invalid = (message: string) => new BrokerError(422, 40010001, message);
const forbidden = (message: string) => new BrokerError(403, 40310000, message);

const ORDER_TYPES: OrderType[] = ["market", "limit", "stop", "stop_limit", "trailing_stop"];
const TIMES_IN_FORCE: TimeInForce[] = ["day", "gtc", "opg", "cls", "ioc", "fok"];
const ORDER_CLASSES: SimOrderClass[] = ["simple", "bracket", "oco", "oto"];
const POSITION_INTENTS: PositionIntent[] = ["buy_to_open", "buy_to_close", "sell_to_open", "sell_to_close"];

const decimalPlaces = (value: number) => {
    const text = String(value);
    if (text.includes("e-")) return Number(text.split("e-")[1]);
    return text.includes(".") ? text.split(".")[1].length : 0;
};

// A positive decimal from a string or number (Alpaca takes both), or null when absent
const parsePositive = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d*\.?\d+\s*$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number <= 0) throw invalid(`${field} must be a positive number`);
    return number;
};

// Whether shares are a whole number (fractional orders have their own rules)
export const isWhole = (qty: number) => Math.abs(qty - Math.round(qty)) < 1e-9;

// Alpaca's tick sizes: whole cents at $1.00 and above, up to 4 decimals below
export const priceIncrementError = (price: number, field: string): BrokerError | null => {
    const allowed = price >= 1 ? 2 : 4;
    return decimalPlaces(price) > allowed
        ? new BrokerError(422, 42210000, `invalid ${field} ${price}. sub-penny increment does not fulfill minimum pricing criteria`)
        : null;
};

export const parseOrderRequest = (request: Partial<CreateOrderRequest> | null): OrderSpec => {
    if (!request || typeof request !== "object") throw invalid("request body format is invalid");
    const symbol = String(request.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) throw invalid("symbol is required");
    if (request.side !== "buy" && request.side !== "sell") throw invalid("side must be buy or sell");
    if (!ORDER_TYPES.includes(request.type as OrderType)) throw invalid(`invalid order type ${request.type ?? ""}`.trim());
    if (!TIMES_IN_FORCE.includes(request.time_in_force as TimeInForce)) throw invalid(`invalid time_in_force ${request.time_in_force ?? ""}`.trim());
    const orderClass = (request.order_class || "simple") as SimOrderClass;
    if (request.order_class === "mleg") throw invalid("mleg orders are for options");
    if (!ORDER_CLASSES.includes(orderClass)) throw invalid(`invalid order_class ${request.order_class}`);
    if (request.position_intent !== undefined && !POSITION_INTENTS.includes(request.position_intent)) throw invalid(`invalid position_intent ${request.position_intent}`);
    const clientOrderId = request.client_order_id === undefined || request.client_order_id === "" ? null : String(request.client_order_id);
    if (clientOrderId !== null && clientOrderId.length > 128) throw invalid("client_order_id must be at most 128 characters");
    const takeProfit = request.take_profit ? { limitPrice: parsePositive(request.take_profit.limit_price, "take_profit.limit_price") } : null;
    const stopLoss = request.stop_loss
        ? { stopPrice: parsePositive(request.stop_loss.stop_price, "stop_loss.stop_price"), limitPrice: parsePositive(request.stop_loss.limit_price, "stop_loss.limit_price") }
        : null;
    if (takeProfit && takeProfit.limitPrice === null) throw invalid("take_profit.limit_price is required");
    if (stopLoss && stopLoss.stopPrice === null) throw invalid("stop_loss.stop_price is required");
    return {
        symbol, side: request.side, type: request.type as OrderType, timeInForce: request.time_in_force as TimeInForce, orderClass,
        positionIntent: request.position_intent ?? null,
        qty: parsePositive(request.qty, "qty"), notional: parsePositive(request.notional, "notional"),
        limitPrice: parsePositive(request.limit_price, "limit_price"), stopPrice: parsePositive(request.stop_price, "stop_price"),
        trailPrice: parsePositive(request.trail_price, "trail_price"), trailPercent: parsePositive(request.trail_percent, "trail_percent"),
        extendedHours: request.extended_hours === true,
        takeProfit: takeProfit as OrderSpec["takeProfit"], stopLoss: stopLoss as OrderSpec["stopLoss"], clientOrderId
    };
};

const EXIT_TICK = 0.01;

// Whether an order only reduces the position (the shares on the closing side)
const closesPosition = (side: OrderSide, position: number) => side === "sell" ? position > 0 : position < 0;

// The shares of the position the other open orders on the closing side already hold
const heldByOrders = (spec: Pick<OrderSpec, "side">, context: OrderContext) => context.openOrders
    .filter(order => order.side === spec.side && !order.held)
    .reduce((sum, order) => sum + (order.remainingQty ?? (context.price ? (order.notionalLeft ?? 0) / context.price : 0)), 0);

// Alpaca rejects an order that could fill against the account's own open order on the other side (a market order, or limits that
// cross), unless they belong to the same bracket, OCO or OTO; stops aren't resting orders, so they don't count
const washTrade = (spec: OrderSpec, context: OrderContext, groupId: string | null): boolean => {
    if (spec.type !== "market" && spec.type !== "limit") return false;
    return context.openOrders.some(order => {
        if (order.side === spec.side || order.held || (groupId && order.groupId === groupId)) return false;
        if (order.type !== "market" && order.type !== "limit") return false;
        if (spec.type === "market" || order.type === "market") return true;
        const buyLimit = spec.side === "buy" ? spec.limitPrice! : order.limitPrice!;
        const sellLimit = spec.side === "sell" ? spec.limitPrice! : order.limitPrice!;
        return buyLimit >= sellLimit;
    });
};

// When OPG and CLS orders may be submitted: Alpaca rejects OPG orders from 9:28 a.m. to 7:00 p.m. ET on a trading day, and CLS orders
// from 3:50 p.m. (10 minutes before the close) to 7:00 p.m.
const auctionWindowError = (timeInForce: TimeInForce, now: Date): string | null => {
    const { dateKey } = easternParts(now);
    const session = sessionOn(dateKey);
    if (!session) return null;
    const evening = easternTime(dateKey, "19:00");
    if (timeInForce === "opg" && now >= new Date(session.open.getTime() - 2 * 60000) && now < evening) {
        return "opg orders can't be submitted from 9:28 a.m. to 7:00 p.m. ET";
    }
    if (timeInForce === "cls" && now >= new Date(session.close.getTime() - 10 * 60000) && now < evening) {
        return "cls orders can't be submitted from 10 minutes before the close to 7:00 p.m. ET";
    }
    return null;
};

// Checks an order against Alpaca's rules, throwing the BrokerError Alpaca would answer with. groupId is the group of the order being
// replaced (its own orders don't count as wash trades).
export const validateOrder = (spec: OrderSpec, context: OrderContext, { groupId = null, replacing = false }: { groupId?: string | null; replacing?: boolean } = {}) => {
    const { type, timeInForce, orderClass, side, qty, notional } = spec;
    if (context.asset && context.asset.tradable === false) throw invalid(`asset ${spec.symbol} is not tradable`);
    if (orderClass === "oco" ? qty === null : (qty === null) === (notional === null)) {
        throw invalid(qty !== null && notional !== null ? "only one of qty or notional can be set" : orderClass === "oco" ? "qty is required for oco orders" : "qty or notional is required");
    }
    if (qty !== null && decimalPlaces(qty) > 9) throw invalid("qty can have at most 9 decimal places");
    if (notional !== null && (notional < 1 || decimalPlaces(notional) > 2)) throw invalid("notional must be at least $1.00, in whole cents");

    // The prices each type needs
    if ((type === "limit" || type === "stop_limit") && spec.limitPrice === null && orderClass !== "oco") throw invalid("limit_price is required for limit orders");
    if ((type === "stop" || type === "stop_limit") && spec.stopPrice === null) throw invalid("stop_price is required for stop orders");
    if (type === "trailing_stop") {
        if ((spec.trailPrice === null) === (spec.trailPercent === null)) throw invalid("trailing_stop orders need exactly one of trail_price or trail_percent");
        if (spec.trailPercent !== null && spec.trailPercent >= 100) throw invalid("trail_percent must be below 100");
        if (timeInForce !== "day" && timeInForce !== "gtc") throw invalid("trailing_stop orders must be day or gtc");
        if (orderClass !== "simple") throw invalid("trailing_stop orders can't be bracket, oco or oto orders");
    }
    for (const [field, price] of [["limit_price", spec.limitPrice], ["stop_price", spec.stopPrice], ["trail_price", spec.trailPrice],
        ["take_profit.limit_price", spec.takeProfit?.limitPrice ?? null], ["stop_loss.stop_price", spec.stopLoss?.stopPrice ?? null],
        ["stop_loss.limit_price", spec.stopLoss?.limitPrice ?? null]] as const) {
        const error = price === null ? null : priceIncrementError(price, field);
        if (error) throw error;
    }

    // Times in force
    if ((timeInForce === "opg" || timeInForce === "cls" || timeInForce === "ioc" || timeInForce === "fok") && type !== "market" && type !== "limit") {
        throw invalid(`${timeInForce} orders must be market or limit orders`);
    }
    if ((timeInForce === "opg" || timeInForce === "cls" || timeInForce === "ioc" || timeInForce === "fok") && orderClass !== "simple") {
        throw invalid(`${timeInForce} orders can't be bracket, oco or oto orders`);
    }
    const window = timeInForce === "opg" || timeInForce === "cls" ? auctionWindowError(timeInForce, context.now) : null;
    if (window) throw invalid(window);

    // Extended hours: day or GTC limit orders only, not bracket, OCO or OTO
    if (spec.extendedHours) {
        if (type !== "limit" || (timeInForce !== "day" && timeInForce !== "gtc")) throw invalid("extended hours orders must be day or gtc limit orders");
        if (orderClass !== "simple") throw invalid("extended hours orders can't be bracket, oco or oto orders");
    }

    // Fractional and notional orders: day orders, simple, on fractionable assets, never sold short
    const fractional = notional !== null || (qty !== null && !isWhole(qty));
    if (fractional) {
        if (context.configurations.fractional_trading === false) throw forbidden("fractional trading is disabled for this account");
        if (context.asset?.fractionable === false) throw invalid(`asset ${spec.symbol} is not fractionable`);
        if (timeInForce !== "day") throw invalid("fractional orders must be day orders");
        if (orderClass !== "simple") throw invalid("fractional orders can't be bracket, oco or oto orders");
        if (notional !== null && type !== "market" && type !== "limit") throw invalid("notional orders must be market or limit orders");
        if (type === "trailing_stop") throw invalid("fractional orders can't be trailing stops");
        if (spec.extendedHours && !context.asset?.attributes.includes("fractional_eh_enabled")) throw invalid(`fractional orders on ${spec.symbol} can't trade in extended hours`);
        if (side === "sell" && !(context.position > 0)) throw forbidden("fractional orders can't be sold short");
    }
    if (replacing) return;

    // Bracket, OTO and OCO legs, judged against the entry's base price (its limit, else the current price) for brackets and OTOs
    if (orderClass === "bracket" || orderClass === "oto") {
        if (type !== "market" && type !== "limit" && orderClass === "bracket") throw invalid("bracket orders must be market or limit orders");
        if (timeInForce !== "day" && timeInForce !== "gtc") throw invalid(`${orderClass} orders must be day or gtc`);
        if (orderClass === "bracket" && (!spec.takeProfit || !spec.stopLoss)) throw invalid("bracket orders need take_profit and stop_loss");
        if (orderClass === "oto" && (spec.takeProfit === null) === (spec.stopLoss === null)) throw invalid("oto orders need exactly one of take_profit or stop_loss");
        const base = spec.limitPrice ?? spec.stopPrice ?? context.price;
        if (base !== null) {
            const sign = side === "buy" ? 1 : -1;
            if (spec.takeProfit && sign * (spec.takeProfit.limitPrice - base) < EXIT_TICK - 1e-9) {
                throw invalid(`take_profit.limit_price must be ${side === "buy" ? ">=" : "<="} base_price ${side === "buy" ? "+" : "-"} 0.01 (base price ${base})`);
            }
            if (spec.stopLoss && sign * (base - spec.stopLoss.stopPrice) < EXIT_TICK - 1e-9) {
                throw invalid(`stop_loss.stop_price must be ${side === "buy" ? "<=" : ">="} base_price ${side === "buy" ? "-" : "+"} 0.01 (base price ${base})`);
            }
        }
    } else if (orderClass === "oco") {
        if (type !== "limit") throw invalid("oco orders must be limit orders");
        if (timeInForce !== "day" && timeInForce !== "gtc") throw invalid("oco orders must be day or gtc");
        if (!spec.takeProfit || !spec.stopLoss) throw invalid("oco orders need take_profit and stop_loss");
        const sign = side === "sell" ? 1 : -1;
        if (sign * (spec.takeProfit.limitPrice - spec.stopLoss.stopPrice) < EXIT_TICK - 1e-9) {
            throw invalid(`take_profit.limit_price must be ${side === "sell" ? "above" : "below"} stop_loss.stop_price`);
        }
        if (!closesPosition(side, context.position)) throw forbidden("oco orders must close an open position");
    } else if (spec.takeProfit || spec.stopLoss) {
        throw invalid("take_profit and stop_loss are only for bracket, oco and oto orders");
    }

    // Position intent: its side must match, and a close needs a position on the closing side
    if (spec.positionIntent) {
        if (!spec.positionIntent.startsWith(side)) throw invalid(`position_intent ${spec.positionIntent} doesn't match side ${side}`);
        if (spec.positionIntent.endsWith("_to_close") && !closesPosition(side, context.position)) {
            throw forbidden(`insufficient qty available for order (requested: ${qty ?? notional}, available: 0)`);
        }
        if (spec.positionIntent.endsWith("_to_open") && closesPosition(side, context.position)) {
            throw forbidden(`position_intent ${spec.positionIntent} would trade against the open ${context.position > 0 ? "long" : "short"} position; close it first`);
        }
    }

    // An order can't go through zero: against a position it closes no more than the shares the other open orders don't already hold
    // (a *_to_close order is capped at the position when it fills, so it only needs some to be available)
    if (closesPosition(side, context.position)) {
        const available = Math.max(0, Math.abs(context.position) - heldByOrders(spec, context));
        const requested = qty ?? (context.price ? notional! / context.price : 0);
        const capped = spec.positionIntent?.endsWith("_to_close");
        if (capped ? available <= 1e-9 : requested > available + 1e-9) {
            throw forbidden(`insufficient qty available for order (requested: ${parseFloat(requested.toFixed(9))}, available: ${parseFloat(available.toFixed(9))})`);
        }
    } else if (side === "sell") {
        if (context.configurations.no_shorting) throw forbidden("account is not allowed to short");
        if (context.asset?.shortable === false) throw forbidden(`asset ${spec.symbol} cannot be sold short`);
    }
    if (orderClass !== "oco" && washTrade(spec, context, groupId)) throw forbidden("potential wash trade detected. use complex orders");
};

// When an order accepted now stops working, unless it fills first: a day order at the close of the session it trades in (today's,
// or the next trading day's once it has closed), an extended-hours one at the end of the after-hours session; OPG at the open and CLS
// at the close (both settled in the auction); IOC and FOK at the next close (they're decided at once, or at the open); GTC after 90
// days, at that day's close, as Alpaca ages GTC orders out.
export const orderExpiry = ({ timeInForce, extendedHours }: Pick<OrderSpec, "timeInForce" | "extendedHours">, now: Date): Date => {
    const { dateKey } = easternParts(now);
    const sessionFrom = (day: string) => {
        let key = isTradingDay(day) ? day : nextTradingDay(day);
        // A session that has already ended today gives way to the next one
        while (true) {
            const session = sessionOn(key)!;
            const end = timeInForce === "opg" ? session.open : extendedHours ? session.extendedClose : session.close;
            if (end > now) return { session, end };
            key = nextTradingDay(key);
        }
    };
    if (timeInForce === "gtc") return sessionFrom(addDays(dateKey, 90)).session.close;
    return sessionFrom(dateKey).end;
};

// The order a replace asks for: the original with the fields it changes. Alpaca replaces whole-share quantities only, can't change a
// fractional order's quantity, and can't replace notional orders at all.
export const applyReplace = (original: OrderSpec, update: Partial<UpdateOrderRequest> | null, filledQty: number): OrderSpec => {
    if (!update || typeof update !== "object") throw invalid("request body format is invalid");
    if (original.notional !== null) throw invalid("notional orders can't be replaced; cancel and resubmit instead");
    if (filledQty > 0) throw invalid("a partially filled order can't be replaced in the simulator; cancel it and submit the rest");
    const qty = parsePositive(update.qty, "qty");
    if (qty !== null && !isWhole(qty)) throw invalid("qty can only be replaced with whole shares");
    if (qty !== null && original.qty !== null && !isWhole(original.qty) && qty !== original.qty) throw invalid("the qty of a fractional order can't change");
    if (update.notional !== undefined) throw invalid("notional can only be replaced on IPO orders");
    if (update.time_in_force !== undefined && !TIMES_IN_FORCE.includes(update.time_in_force)) throw invalid(`invalid time_in_force ${update.time_in_force}`);
    const limitPrice = parsePositive(update.limit_price, "limit_price");
    const stopPrice = parsePositive(update.stop_price, "stop_price");
    const trail = parsePositive(update.trail, "trail");
    if (limitPrice !== null && original.type !== "limit" && original.type !== "stop_limit") throw invalid("limit_price can only be replaced on limit and stop_limit orders");
    if (stopPrice !== null && original.type !== "stop" && original.type !== "stop_limit") throw invalid("stop_price can only be replaced on stop and stop_limit orders");
    if (trail !== null && original.type !== "trailing_stop") throw invalid("trail can only be replaced on trailing_stop orders");
    if (qty === null && limitPrice === null && stopPrice === null && trail === null && update.time_in_force === undefined) {
        throw invalid("nothing to replace: send qty, limit_price, stop_price, trail or time_in_force");
    }
    return {
        ...original,
        qty: qty ?? original.qty,
        limitPrice: limitPrice ?? original.limitPrice,
        stopPrice: stopPrice ?? original.stopPrice,
        trailPrice: trail !== null && original.trailPrice !== null ? trail : original.trailPrice,
        trailPercent: trail !== null && original.trailPercent !== null ? trail : original.trailPercent,
        timeInForce: update.time_in_force ?? original.timeInForce,
        clientOrderId: update.client_order_id ? String(update.client_order_id) : null
    };
};
