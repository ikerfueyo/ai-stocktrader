// Corporate actions as Alpaca processes them (docs.alpaca.markets/docs/mandatory-corporate-actions): their effect on an account's
// tax lots, the activities they post, and what they do to open orders. Pure, so it can be unit tested; ./positions.ts applies them to
// accounts and ./orders.ts to orders.
//   Lots: splits and stock dividends multiply the shares and divide the price; a stock merger moves the lots to the acquirer, and a
//   spinoff adds lots of the new company, both keeping each lot's acquisition date (the holding period carries over), a spinoff
//   allocating the basis by market value; cash and mixed mergers close the shares for the cash, realizing against the basis (a mixed
//   merger's basis split between the new shares and the cash by market value); a worthless removal closes them at nothing. Short lots
//   follow the same rules with the cash going the other way. With cashInLieu, a fractional share left by a split, stock dividend,
//   merger or spinoff is paid out in cash (CIL) at the new price instead of kept.
//   Orders (placed before the effective date): a reverse split cancels them; a forward split or stock dividend adjusts GTC buy limits
//   and sell stops (shares × the ratio, prices ÷ it) and cancels the rest; a cash dividend lowers GTC buy limits and sell stops by the
//   dividend; a spinoff, merger, symbol change or worthless removal cancels them. Bracket, OCO and OTO orders are sent do-not-reduce,
//   do-not-cancel, so they're left as they are, except where the security goes away (mergers, symbol changes, worthless removals).
import type { Lot } from "./ledger";
import type { OrderSide, OrderType, TimeInForce } from "../types";

export type CorporateActionType = "SPLIT" | "DIVIDEND" | "STOCK_DIVIDEND" | "CASH_MERGER" | "STOCK_MERGER" | "MIXED_MERGER" | "SPINOFF" | "NAME_CHANGE" | "WORTHLESS";

export interface CorporateAction {
    type: CorporateActionType;
    symbol: string;
    // The acquirer, the spun-off company or the new symbol
    newSymbol: string | null;
    // New shares per old share (splits, stock dividends as 1 + the rate, stock and mixed mergers, spinoffs)
    factor: number | null;
    // Cash per share (dividends, cash and mixed mergers)
    cash: number | null;
    exDate: string;
}

// An activity the action posts to the account, in Alpaca's types: SPLIT (FSPLIT, RSPLIT), DIV (SDIV), MA (CMA, SMA, SCMA), SPIN,
// REORG (WRM), CIL. qty is signed (shares received or removed) and netAmount the cash; tag names it for the closings booked under it.
export interface ActionActivity {
    tag: string;
    type: "SPLIT" | "DIV" | "MA" | "SPIN" | "REORG" | "CIL";
    subType: string | null;
    symbol: string;
    qty: number;
    netAmount: number;
    description: string;
}

// Shares closed for cash (or for nothing), and what that realized against their basis: a lot (lotId), or a lot the action opens
// (openedIndex, into opened)
export interface LotClosing {
    lotId: string | null;
    openedIndex?: number;
    qty: number;
    lotPrice: number;
    // What each share was closed at
    price: number;
    realized: number;
    tag: string;
}

export interface LotEffect {
    // Every affected lot's state after the action: its shares (0 once closed or moved), price and symbol
    updates: { id: string; symbol: string; qty: number; price: number }[];
    closings: LotClosing[];
    // New lots (a spinoff's), each keeping its source lot's acquisition date
    opened: { sourceLotId: string; symbol: string; side: "long" | "short"; qty: number; price: number; acquiredAt: string }[];
    activities: ActionActivity[];
    // The net cash the action moves (positive received) and the P&L it realizes
    cash: number;
    realized: number;
}

const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const cents = (value: number) => Math.round(value * 100) / 100;
const shares = (qty: number) => parseFloat(qty.toFixed(6));

// The market values that allocate basis: the old and new symbols' prices on the effective date (null when unknown)
export interface ActionPrices {
    symbol: number | null;
    newSymbol: number | null;
}

const ratioLabel = (factor: number) => factor >= 1 ? `${parseFloat(factor.toFixed(6))}-for-1` : `1-for-${parseFloat((1 / factor).toFixed(6))}`;

// The action's effect on the lots of its symbol held when it took effect (all on one side). Nothing for a cash dividend (posted by
// planDividends on its payment date) or without lots.
export const applyActionToLots = (lots: Lot[], action: CorporateAction, { prices, cashInLieu = false }: { prices: ActionPrices; cashInLieu?: boolean }): LotEffect => {
    const effect: LotEffect = { updates: [], closings: [], opened: [], activities: [], cash: 0, realized: 0 };
    const held = lots.filter(lot => lot.qty > 0).sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.id.localeCompare(b.id));
    if (held.length === 0 || action.type === "DIVIDEND") return effect;
    const side = held[0].side;
    // A long receives cash and realizes what it's paid less its basis; a short pays it and realizes what it sold for less that
    const sign = side === "long" ? 1 : -1;
    const total = round9(held.reduce((sum, lot) => sum + lot.qty, 0));
    const { symbol } = action;
    const factor = action.factor ?? 1;
    const cash = action.cash ?? 0;
    const activity = (entry: ActionActivity) => effect.activities.push({ ...entry, qty: shares(entry.qty) });
    // Activities posted after the action's own (cash in lieu)
    const afterwards: (() => void)[] = [];

    // New lots of newSymbol at ratio new shares per old, keeping the given share of each lot's basis; with cash in lieu, a long's
    // fractional share is paid out at the new price from its newest lot. Returns the shares received (before any cash in lieu).
    const reshape = (newSymbol: string, ratio: number, basisShare = 1, into: "update" | "open" = "update") => {
        const result = held.map(lot => ({ lot, qty: round9(lot.qty * ratio), price: round6(lot.price * basisShare / ratio) }));
        const received = round9(result.reduce((sum, { qty }) => sum + qty, 0));
        const fraction = round9(received - Math.floor(received + 1e-9));
        const newPrice = prices.newSymbol ?? (newSymbol === symbol && prices.symbol !== null ? prices.symbol / ratio : null);
        let lieu: { index: number; qty: number; price: number; lotPrice: number } | null = null;
        if (cashInLieu && side === "long" && fraction > 1e-9 && Number.isInteger(total) && newPrice !== null) {
            const newest = result.length - 1;
            result[newest].qty = round9(result[newest].qty - fraction);
            lieu = { index: newest, qty: fraction, price: newPrice, lotPrice: result[newest].price };
        }
        result.forEach(({ lot, qty, price }, index) => {
            if (into === "update") effect.updates.push({ id: lot.id, symbol: newSymbol, qty, price });
            else if (qty > 0 || lieu?.index === index) effect.opened.push({ sourceLotId: lot.id, symbol: newSymbol, side, qty, price, acquiredAt: lot.acquiredAt });
        });
        if (lieu) {
            const proceeds = cents(lieu.qty * lieu.price);
            const realized = (lieu.price - lieu.lotPrice) * lieu.qty;
            const target = into === "update" ? { lotId: result[lieu.index].lot.id } : { lotId: null, openedIndex: effect.opened.length - 1 };
            effect.closings.push({ ...target, qty: lieu.qty, lotPrice: lieu.lotPrice, price: lieu.price, realized, tag: "cil" });
            effect.realized += realized;
            effect.cash += proceeds;
            // Posted after the action's own activities
            afterwards.push(() => activity({ tag: "cil", type: "CIL", subType: null, symbol: newSymbol, qty: -lieu!.qty, netAmount: proceeds, description: `Cash in lieu of ${shares(lieu!.qty)} ${newSymbol} shares at $${lieu!.price}` }));
        }
        return received;
    };
    // Closes every lot for price a share, under tag
    const closeAll = (price: number, tag: string) => {
        for (const lot of held) {
            const realized = sign * (price - lot.price) * lot.qty;
            effect.closings.push({ lotId: lot.id, qty: lot.qty, lotPrice: lot.price, price, realized, tag });
            effect.updates.push({ id: lot.id, symbol: lot.symbol, qty: 0, price: lot.price });
            effect.realized += realized;
        }
    };

    switch (action.type) {
        case "SPLIT": {
            const received = reshape(symbol, factor);
            activity({ tag: "split", type: "SPLIT", subType: factor >= 1 ? "FSPLIT" : "RSPLIT", symbol, qty: sign * (received - total), netAmount: 0, description: `${symbol} ${ratioLabel(factor)}${factor >= 1 ? "" : " reverse"} split` });
            break;
        }
        case "STOCK_DIVIDEND": {
            const received = reshape(symbol, factor);
            activity({ tag: "sdiv", type: "DIV", subType: "SDIV", symbol, qty: sign * (received - total), netAmount: 0, description: `${symbol} stock dividend: ${parseFloat(((factor - 1) * 100).toFixed(4))}% in shares` });
            break;
        }
        case "STOCK_MERGER": {
            const acquirer = action.newSymbol!;
            const received = reshape(acquirer, factor);
            activity({ tag: "removed", type: "MA", subType: "SMA", symbol, qty: -sign * total, netAmount: 0, description: `${symbol} merged into ${acquirer}: shares removed` });
            activity({ tag: "received", type: "MA", subType: "SMA", symbol: acquirer, qty: sign * received, netAmount: 0, description: `${acquirer} received for ${symbol}: ${factor} per share` });
            break;
        }
        case "MIXED_MERGER": {
            // The basis splits between the new shares and the cash by market value; without the acquirer's price, the cash first
            // returns basis
            const acquirer = action.newSymbol!;
            const stockValue = prices.newSymbol !== null ? factor * prices.newSymbol : null;
            const stockShare = stockValue !== null && stockValue + cash > 0 ? stockValue / (stockValue + cash) : null;
            const proceeds = cents(sign * cash * total);
            activity({ tag: "removed", type: "MA", subType: "SCMA", symbol, qty: -sign * total, netAmount: 0, description: `${symbol} merged into ${acquirer}: shares removed` });
            let realized = 0;
            const keep = held.map(lot => {
                const cashBasis = stockShare !== null ? lot.price * (1 - stockShare) : Math.min(lot.price, cash);
                const gain = sign * (cash - cashBasis) * lot.qty;
                effect.closings.push({ lotId: lot.id, qty: lot.qty, lotPrice: cashBasis, price: cash, realized: gain, tag: "cash" });
                realized += gain;
                return lot.price > 0 ? (lot.price - cashBasis) / lot.price : 0;
            });
            effect.realized += realized;
            effect.cash += proceeds;
            // Each lot keeps the rest of its basis in the new shares
            const original = held.map(lot => ({ ...lot }));
            held.forEach((lot, index) => { lot.price = lot.price * keep[index]; });
            const received = reshape(acquirer, factor);
            held.splice(0, held.length, ...original);
            activity({ tag: "received", type: "MA", subType: "SCMA", symbol: acquirer, qty: sign * received, netAmount: 0, description: `${acquirer} received for ${symbol}: ${factor} per share` });
            activity({ tag: "cash", type: "MA", subType: "SCMA", symbol, qty: 0, netAmount: proceeds, description: `${symbol} merger cash: $${cash} per share` });
            break;
        }
        case "CASH_MERGER": {
            const proceeds = cents(sign * cash * total);
            closeAll(cash, "cash");
            effect.cash += proceeds;
            activity({ tag: "cash", type: "MA", subType: "CMA", symbol, qty: -sign * total, netAmount: proceeds, description: `${symbol} acquired for cash: $${cash} per share` });
            break;
        }
        case "WORTHLESS": {
            closeAll(0, "removed");
            activity({ tag: "removed", type: "REORG", subType: "WRM", symbol, qty: -sign * total, netAmount: 0, description: `${symbol} removed as worthless` });
            break;
        }
        case "SPINOFF": {
            // The basis moves to the new company's shares in proportion to market value (none without both prices)
            const spun = action.newSymbol!;
            const newValue = prices.newSymbol !== null ? factor * prices.newSymbol : null;
            const share = newValue !== null && prices.symbol !== null && newValue + prices.symbol > 0 ? newValue / (newValue + prices.symbol) : 0;
            for (const lot of held) effect.updates.push({ id: lot.id, symbol, qty: lot.qty, price: round6(lot.price * (1 - share)) });
            const received = reshape(spun, factor, share, "open");
            activity({ tag: "spin", type: "SPIN", subType: null, symbol: spun, qty: sign * received, netAmount: 0, description: `${spun} spun off from ${symbol}: ${factor} per share${share > 0 ? `, with ${(share * 100).toFixed(2)}% of the basis` : ""}` });
            break;
        }
        case "NAME_CHANGE":
            for (const lot of held) effect.updates.push({ id: lot.id, symbol: action.newSymbol!, qty: lot.qty, price: lot.price });
            break;
    }
    for (const post of afterwards) post();
    effect.cash = cents(effect.cash);
    return effect;
};

export interface AdjustableOrder {
    side: OrderSide;
    type: OrderType;
    timeInForce: TimeInForce;
    orderClass: string;
    qty: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
}

export type OrderAdjustment =
    | { kind: "keep" }
    | { kind: "cancel"; reason: string }
    | { kind: "replace"; qty: number | null; limitPrice: number | null; stopPrice: number | null; reason: string };

// Rounds a price down to its tick (cents at $1 and above, 4 decimals below)
export const roundDownToTick = (price: number) => {
    const places = price >= 1 ? 100 : 10000;
    return Math.floor(price * places + 1e-6) / places;
};

// GTC buy limits and sell stops (and sell stop limits) are the orders exchanges adjust for splits and dividends
const adjustable = (order: AdjustableOrder) =>
    order.timeInForce === "gtc" && ((order.side === "buy" && order.type === "limit") || (order.side === "sell" && (order.type === "stop" || order.type === "stop_limit")));

// What an action does to an open order of its symbol placed before its effective date
export const adjustOrder = (order: AdjustableOrder, action: CorporateAction): OrderAdjustment => {
    const reason = "CORPORATE_ACTION";
    const grouped = order.orderClass !== "simple";
    const goesAway = ["CASH_MERGER", "STOCK_MERGER", "MIXED_MERGER", "NAME_CHANGE", "WORTHLESS"].includes(action.type);
    if (goesAway) return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
    if (grouped) return { kind: "keep" };
    const factor = action.factor ?? 1;
    if (action.type === "DIVIDEND") {
        if (!adjustable(order) || !action.cash) return { kind: "keep" };
        const lower = (price: number | null) => price === null ? null : roundDownToTick(price - action.cash!);
        const limitPrice = lower(order.limitPrice);
        const stopPrice = lower(order.stopPrice);
        if ((limitPrice !== null && limitPrice <= 0) || (stopPrice !== null && stopPrice <= 0)) return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
        return { kind: "replace", qty: order.qty, limitPrice, stopPrice, reason: `${reason}: ${describe(action)}` };
    }
    if (action.type === "SPLIT" && factor < 1) return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
    if (action.type === "SPLIT" || action.type === "STOCK_DIVIDEND") {
        if (!adjustable(order)) return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
        const divide = (price: number | null) => price === null ? null : roundDownToTick(price / factor);
        const qty = order.qty === null ? null : Math.floor(order.qty * factor + 1e-9);
        if (qty !== null && qty < 1) return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
        return { kind: "replace", qty, limitPrice: divide(order.limitPrice), stopPrice: divide(order.stopPrice), reason: `${reason}: ${describe(action)}` };
    }
    // Spinoffs
    return { kind: "cancel", reason: `${reason}: ${describe(action)}` };
};

export const describe = (action: CorporateAction): string => {
    const factor = action.factor ?? 1;
    switch (action.type) {
        case "SPLIT": return `${action.symbol} ${ratioLabel(factor)}${factor >= 1 ? "" : " reverse"} split`;
        case "DIVIDEND": return `${action.symbol} $${action.cash} dividend`;
        case "STOCK_DIVIDEND": return `${action.symbol} ${parseFloat(((factor - 1) * 100).toFixed(4))}% stock dividend`;
        case "CASH_MERGER": return `${action.symbol} acquired for $${action.cash} a share`;
        case "STOCK_MERGER": return `${action.symbol} merged into ${action.newSymbol}, ${factor} shares each`;
        case "MIXED_MERGER": return `${action.symbol} merged into ${action.newSymbol}, ${factor} shares and $${action.cash} each`;
        case "SPINOFF": return `${action.newSymbol} spun off from ${action.symbol}, ${factor} per share`;
        case "NAME_CHANGE": return `${action.symbol} renamed ${action.newSymbol}`;
        case "WORTHLESS": return `${action.symbol} removed as worthless`;
    }
};
