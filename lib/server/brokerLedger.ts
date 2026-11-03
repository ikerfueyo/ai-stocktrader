// The app's view of an account read through the Broker interface alone, for brokers whose ledger the app can't query (BROKER=alpaca;
// with the simulator, lib/server/portfolio.ts reads its richer ledger directly). Everything comes from Alpaca's endpoints: positions,
// the trading account, and the account's activities, whose fills are replayed FIFO with the stored corporate actions (replayFills)
// for what Alpaca doesn't report: realized P&L per fill, open tax lots and the
// year's gains and losses (its 1099 is the record). Kept free of the database and server-only modules, so it's tested with a fake
// broker, and the scenarios check it against SimBroker.
import { easternParts, easternTime, settlementDate } from "../marketHours";
import { applyFill, applySplit, isLongTerm, type Lot } from "./broker/sim/ledger";
import { reportSales, sharesSince, taxYear, unrealizedRows, type Acquisition, type Disposal, type ShareChange, type TaxYear } from "./broker/sim/tax";
import { applyActionToLots, type ActionPrices, type CorporateAction } from "./broker/sim/corporateActions";
import type { Broker } from "./broker/broker";
import type { AccountConfigurations, Activity, Position as BrokerPosition, TradeAccount } from "./broker/types";
import type { Account, CashActivityRow, Position, TaxLot, TradeHistoryRow } from "../types";
import type { Split, Trade } from "./account";

const roundCents = (value: number) => Math.round(value * 100) / 100;
const dayOf = (iso: string) => easternParts(new Date(iso)).dateKey;

// Alpaca's page size for activities, and its largest
const PAGE_SIZE = 100;

// Every activity of the types asked for, oldest first, following Alpaca's page_token paging (the last ID of each page)
export const listAllActivities = async (broker: Pick<Broker, "listActivities">, accountId: string, types: string[]): Promise<Activity[]> => {
    const all: Activity[] = [];
    let pageToken: string | undefined;
    for (;;) {
        const page = await broker.listActivities(accountId, { activity_types: types.join(","), direction: "asc", page_size: PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) } as never);
        all.push(...page);
        const last = (page[page.length - 1] as { id?: string } | undefined)?.id;
        if (page.length < PAGE_SIZE || !last || last === pageToken) return all;
        pageToken = last;
    }
};

// A fill as the replay reads it
export interface BrokerFill {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    at: string;
    orderId: string | null;
}

export const fillsOf = (activities: Activity[]): BrokerFill[] =>
    (activities as (Activity & { id?: string; activity_type?: string })[])
        .filter(activity => activity.activity_type === "FILL")
        .map(activity => {
            const fill = activity as { id?: string; symbol?: string; side?: string; qty?: string; price?: string; transaction_time?: string; order_id?: string };
            return {
                id: String(fill.id), symbol: String(fill.symbol ?? "").toUpperCase(), side: fill.side === "buy" ? "buy" as const : "sell" as const,
                qty: Math.abs(Number(fill.qty)), price: Number(fill.price), at: String(fill.transaction_time), orderId: fill.order_id ?? null
            };
        })
        .filter(fill => fill.qty > 0 && fill.price > 0 && fill.symbol)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

export interface ReplayedLot extends Lot {
    // Split-adjusted shares when it was opened
    originalQty: number;
}

export interface Replay {
    lots: ReplayedLot[];
    // What each fill realized (null for one that only opened or added), in dollars
    realizedByFill: Map<string, number | null>;
    realized: number;
    acquisitions: Acquisition[];
    disposals: Disposal[];
}

// A stored corporate action that changes shares other than a split (stock dividends, mergers, spinoffs, symbol changes, worthless
// removals), with the effective date's closes a spinoff or mixed merger allocates basis by (null when unknown)
export interface ShareAction {
    action: CorporateAction;
    prices: ActionPrices;
}

// The symbols and days cash in lieu was paid on (CIL activities), so an action is replayed paying out its fractional share as the
// broker did
export const cashInLieuOf = (activities: Activity[]): Set<string> => new Set(
    (activities as (Activity & { activity_type?: string; symbol?: string; date?: string })[])
        .filter(activity => activity.activity_type === "CIL" && activity.symbol && activity.date)
        .map(activity => `${String(activity.symbol).toUpperCase()}|${activity.date}`)
);

// The share changes the tax rules follow (sharesSince): splits, stock dividends, stock and mixed mergers, and symbol changes
const SHARE_CHANGE_TYPES = new Set(["STOCK_DIVIDEND", "STOCK_MERGER", "MIXED_MERGER", "NAME_CHANGE"]);
const DISPOSAL_KINDS: Partial<Record<string, Disposal["kind"]>> = { CASH_MERGER: "merger", MIXED_MERGER: "merger", WORTHLESS: "worthless" };

// Replays the fills FIFO (lib/server/broker/sim/ledger.ts's applyFill) as the simulator keeps its lots, since Alpaca's activities
// keep the terms of their day: each split, and each stored share-changing action (applyActionToLots: stock dividends, mergers,
// spinoffs, symbol changes, worthless removals), applied to the lots acquired before its effective date. The broker's positions stay
// the source of what's held.
export const replayFills = (fills: BrokerFill[], splits: Split[], today = easternParts(new Date()).dateKey, { actions = [], cashInLieu = new Set() }: {
    actions?: ShareAction[]; cashInLieu?: Set<string>;
} = {}): Replay => {
    const lots = new Map<string, ReplayedLot[]>();
    const realizedByFill = new Map<string, number | null>();
    const acquisitions: Acquisition[] = [];
    const acquisitionOf = new Map<string, Acquisition>();
    const disposals: Disposal[] = [];
    const original = new Map<string, number>();
    let realized = 0;
    const withOriginal = (lot: Lot): ReplayedLot => ({ ...lot, originalQty: original.get(lot.id) ?? lot.qty });

    // A split onto the lots acquired before it; the acquisitions are kept in today's terms, as the wash sale rule compares shares
    const applySplitToLots = (split: Split) => {
        const symbol = split.ticker.toUpperCase();
        const open = lots.get(symbol) ?? [];
        const before = open.filter(lot => dayOf(lot.acquiredAt) < split.exDate);
        const split_ = applySplit(before, split.factor);
        for (const lot of split_) original.set(lot.id, (original.get(lot.id) ?? lot.qty) * split.factor);
        lots.set(symbol, [...open.filter(lot => !before.includes(lot)), ...split_.map(withOriginal)]);
        for (const acquisition of acquisitions) if (acquisition.symbol === symbol && dayOf(acquisition.acquiredAt) < split.exDate) acquisition.qty *= split.factor;
    };
    // Another action onto the lots of its symbol acquired before it: their new shares, prices and symbols, the new lots it opens (not
    // purchases, so they replace no shares sold at a loss), and its closings for cash or nothing
    const applyShareAction = ({ action, prices }: ShareAction) => {
        const open = lots.get(action.symbol) ?? [];
        const before = open.filter(lot => dayOf(lot.acquiredAt) < action.exDate && lot.qty > 0);
        if (before.length === 0) return;
        const lieu = cashInLieu.has(`${action.symbol}|${action.exDate}`) || (action.newSymbol !== null && cashInLieu.has(`${action.newSymbol}|${action.exDate}`));
        const effect = applyActionToLots(before, action, { prices, cashInLieu: lieu });
        const byId = new Map(before.map(lot => [lot.id, lot]));
        const updated = new Set(effect.updates.map(({ id }) => id));
        lots.set(action.symbol, open.filter(lot => !updated.has(lot.id)));
        const add = (lot: ReplayedLot) => lots.set(lot.symbol, [...(lots.get(lot.symbol) ?? []), lot]);
        for (const update of effect.updates) {
            const lot = byId.get(update.id)!;
            if (!(update.qty > 0)) continue;
            const ratio = update.qty / lot.qty;
            original.set(lot.id, (original.get(lot.id) ?? lot.qty) * ratio);
            add(withOriginal({ ...lot, symbol: update.symbol, qty: update.qty, price: update.price }));
            const acquisition = acquisitionOf.get(lot.id);
            if (acquisition) {
                acquisition.qty *= ratio;
                acquisition.symbol = update.symbol;
            }
        }
        const opened = effect.opened.map((entry, index): ReplayedLot => {
            const id = `${entry.sourceLotId}|${action.type}|${action.exDate}|${index}`;
            original.set(id, entry.qty);
            return { id, symbol: entry.symbol, side: entry.side, qty: entry.qty, price: entry.price, acquiredAt: entry.acquiredAt, originalQty: entry.qty };
        });
        for (const lot of opened) if (lot.qty > 0) add(lot);
        const closedAt = easternTime(action.exDate, "09:30").toISOString();
        for (const closing of effect.closings) {
            const lot = closing.lotId !== null ? byId.get(closing.lotId)! : opened[closing.openedIndex!];
            // Cash in lieu is paid on the shares received, under their symbol
            const symbol = closing.tag === "cil" ? (closing.lotId !== null ? effect.updates.find(({ id }) => id === closing.lotId)?.symbol ?? lot.symbol : lot.symbol) : action.symbol;
            disposals.push({
                id: `${action.type}|${action.symbol}|${action.exDate}|${lot.id}|${closing.tag}`, lotId: lot.id, symbol, side: lot.side, qty: closing.qty, lotPrice: closing.lotPrice, price: closing.price,
                acquiredAt: lot.acquiredAt, closedAt, kind: closing.tag === "cil" ? "cash_in_lieu" : DISPOSAL_KINDS[action.type] ?? "merger"
            });
        }
        realized += effect.realized;
    };
    // Every split and action that took effect by the day, oldest first, once each
    const pending = [
        ...splits.map(split => ({ exDate: split.exDate, symbol: split.ticker.toUpperCase(), apply: () => applySplitToLots(split) })),
        ...actions.map(entry => ({ exDate: entry.action.exDate, symbol: entry.action.symbol, apply: () => applyShareAction(entry) }))
    ].sort((a, b) => a.exDate.localeCompare(b.exDate) || a.symbol.localeCompare(b.symbol));
    const changesThrough = (day: string) => {
        while (pending.length > 0 && pending[0].exDate <= day) pending.shift()!.apply();
    };

    const applyTrade = (fill: BrokerFill) => {
        const { price } = fill;
        const open = lots.get(fill.symbol) ?? [];
        const result = applyFill(open, { side: fill.side, qty: fill.qty, price, at: fill.at }, `lot-${fill.id}`, fill.symbol);
        const byId = new Map(open.map(lot => [lot.id, lot]));
        for (const closing of result.closings) {
            const lot = byId.get(closing.lotId)!;
            disposals.push({
                id: `${fill.id}|${closing.lotId}`, lotId: closing.lotId, symbol: fill.symbol, side: lot.side, qty: closing.qty, lotPrice: closing.price, price,
                acquiredAt: lot.acquiredAt, closedAt: fill.at, kind: "sale"
            });
        }
        if (result.opened) {
            original.set(result.opened.id, result.opened.qty);
            const acquisition = { lotId: result.opened.id, symbol: fill.symbol, side: result.opened.side, qty: result.opened.qty, acquiredAt: fill.at };
            acquisitions.push(acquisition);
            acquisitionOf.set(result.opened.id, acquisition);
        }
        lots.set(fill.symbol, result.lots.map(withOriginal));
        realizedByFill.set(fill.id, result.closings.length > 0 ? roundCents(result.realized) : null);
        realized += result.realized;
    };

    for (const fill of [...fills].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
        changesThrough(dayOf(fill.at));
        applyTrade(fill);
    }
    changesThrough(today);

    // Shares sold in today's terms, and the symbol they're matched under now (as the simulator's tax inputs: sharesSince)
    const changes: ShareChange[] = [
        ...splits.filter(split => split.exDate <= today).map(split => ({ type: "SPLIT", ticker: split.ticker.toUpperCase(), newTicker: null, exDate: split.exDate, factor: split.factor, taxable: null })),
        ...actions.filter(({ action }) => SHARE_CHANGE_TYPES.has(action.type) && action.exDate <= today)
            .map(({ action }) => ({ type: action.type, ticker: action.symbol, newTicker: action.newSymbol, exDate: action.exDate, factor: action.factor, taxable: action.taxable ?? null }))
    ];
    for (const disposal of disposals) {
        const day = dayOf(disposal.closedAt);
        disposal.sharesNow = disposal.qty * sharesSince(changes, disposal.symbol, day).factor;
        const renamed = sharesSince(changes, disposal.symbol, day, true).symbol;
        if (renamed !== disposal.symbol) disposal.matchSymbol = renamed;
    }
    for (const acquisition of acquisitions) acquisition.symbol = sharesSince(changes, acquisition.symbol, dayOf(acquisition.acquiredAt), true).symbol;
    return { lots: [...lots.values()].flat(), realizedByFill, realized: roundCents(realized), acquisitions, disposals };
};

// The broker's positions as the app's (quantity signed, negative for a short)
export const toAppPositions = (positions: BrokerPosition[]): Position[] => positions.map(position => {
    const qty = Math.abs(Number(position.qty));
    return { ticker: String(position.symbol), quantity: position.side === "short" || Number(position.qty) < 0 ? -qty : qty, avgCost: Number(position.avg_entry_price) };
});

// Fills as the trades the equity history and dividend planning replay
export const tradesOf = (fills: BrokerFill[]): Trade[] => fills.map(fill => ({
    ticker: fill.symbol, type: fill.side === "buy" ? "BUY" : "SELL", price: String(fill.price), quantity: String(fill.qty),
    total: (fill.qty * fill.price).toFixed(2), date: new Date(fill.at)
}));

// Fills as the Trades tab's rows, newest first, with the P&L the replay found and their settlement (T+1)
export const transactionRowsOf = (fills: BrokerFill[], replay: Pick<Replay, "realizedByFill">, userId: string): TradeHistoryRow[] =>
    [...fills].reverse().map(fill => ({
        id: fill.id, user_id: userId, date: fill.at, type: fill.side === "buy" ? "BUY" : "SELL", ticker: fill.symbol, price: String(fill.price), quantity: String(fill.qty),
        total: (fill.qty * fill.price).toFixed(2), reason: null, quote_time: null, fill_policy: null, order_id: fill.orderId,
        realized_pnl: replay.realizedByFill.get(fill.id) ?? null, settle_date: settlementDate(dayOf(fill.at))
    }));

// The cash activities the app shows (deposits, withdrawals, fees, dividends, interest, withholding, corporate actions' cash)
export const CASH_ACTIVITY_TYPES = ["CSD", "CSW", "FEE", "DIV", "DIVCGL", "DIVCGS", "DIVNRA", "DIVROC", "DIVTXEX", "INT", "WH", "MA", "CIL"];

export const cashRowsOf = (activities: Activity[], userId: string): CashActivityRow[] =>
    (activities as (Activity & { id?: string; activity_type?: string; net_amount?: string; description?: string; symbol?: string; date?: string; created_at?: string })[])
        .filter(activity => activity.activity_type !== "FILL" && CASH_ACTIVITY_TYPES.includes(String(activity.activity_type)))
        .filter(activity => !(["MA", "CIL"].includes(String(activity.activity_type)) && Number(activity.net_amount) === 0))
        .map(activity => {
            const type = String(activity.activity_type), amount = Number(activity.net_amount ?? 0);
            return {
                id: String(activity.id), user_id: userId, date: activity.created_at ?? `${activity.date}T16:00:00.000Z`,
                type: type.startsWith("DIV") ? (amount >= 0 ? "DIVIDEND_IN" : "DIVIDEND_OUT") : type === "CSD" ? "DEPOSIT" : type === "CSW" ? "WITHDRAW" : type === "INT" ? "INTEREST"
                    : type === "WH" ? "WITHHOLDING" : type === "MA" || type === "CIL" ? (amount >= 0 ? "CORPORATE_ACTION_IN" : "CORPORATE_ACTION_OUT") : "FEE",
                method: activity.description ?? type, amount: Math.abs(amount).toFixed(2), ticker: activity.symbol ?? null, reference: null
            } satisfies CashActivityRow;
        });

const sumOf = (rows: CashActivityRow[], types: CashActivityRow["type"][]) =>
    roundCents(rows.filter(({ type }) => types.includes(type)).reduce((sum, { type, amount }) => sum + (type.endsWith("_OUT") ? -Number(amount) : Number(amount)), 0));

// The ledger figures the account summary and the pages use, from the trading account, the positions and the activities
export const ledgerOf = ({ trade, positions, activities, splits, actions = [], today = easternParts(new Date()).dateKey }: {
    trade: TradeAccount; positions: BrokerPosition[]; activities: Activity[]; splits: Split[]; actions?: ShareAction[]; today?: string;
}) => {
    const fills = fillsOf(activities);
    const replay = replayFills(fills, splits, today, { actions, cashInLieu: cashInLieuOf(activities) });
    const cash = cashRowsOf(activities, "");
    // Sales that settle after today (T+1): tradable, not yet withdrawable
    const unsettledProceeds = roundCents(fills.filter(fill => fill.side === "sell" && settlementDate(dayOf(fill.at)) > today)
        .reduce((sum, fill) => sum + fill.qty * fill.price, 0));
    return {
        fills, replay, positions: toAppPositions(positions),
        // As the simulator's: the trading account's cash less the withdrawals already requested
        totalCash: roundCents(Number(trade.cash ?? 0) - Number(trade.pending_transfer_out ?? 0)),
        pendingTransferOut: roundCents(Number(trade.pending_transfer_out ?? 0)),
        realizedPnl: replay.realized,
        netDividends: sumOf(cash, ["DIVIDEND_IN", "DIVIDEND_OUT"]),
        unsettledProceeds,
        // Alpaca reports one total of the fees accrued and not yet deducted
        accruedFees: roundCents(Number(trade.accrued_fees ?? 0))
    };
};

// GET /api/account's figures from the broker's trading account (Alpaca's TradeAccount): what it reports as is, the rest derived
// (excess liquidity, the debit) or unknown to the API (buying power held for open orders, accrued interest, margin calls: none)
export const accountSummary = ({ trade, positions, configurations, ledger, marginRate }: {
    trade: TradeAccount; positions: BrokerPosition[]; configurations: AccountConfigurations; ledger: ReturnType<typeof ledgerOf>; marginRate: number;
}): Account => {
    const money = (value: unknown) => roundCents(Number(value ?? 0));
    const equity = money(trade.equity), maintenance = money(trade.maintenance_margin);
    const unrealized = positions.reduce((sum, position) => sum + Number(position.unrealized_pl ?? 0), 0);
    return {
        totalCash: ledger.totalCash,
        buyingPower: money(trade.buying_power),
        regtBuyingPower: money(trade.regt_buying_power),
        nonMarginableBuyingPower: money(trade.non_marginable_buying_power),
        reservedCash: 0,
        multiplier: Number(trade.multiplier ?? 1),
        maxMultiplier: Number(configurations.max_margin_multiplier ?? trade.multiplier ?? 1),
        equity,
        longMarketValue: money(trade.long_market_value),
        shortMarketValue: Math.abs(money(trade.short_market_value)),
        initialMargin: money(trade.initial_margin),
        maintenanceMargin: maintenance,
        excessLiquidity: roundCents(equity - maintenance),
        sma: money(trade.sma),
        debitBalance: Math.max(0, -ledger.totalCash),
        marginRate,
        accruedInterest: 0,
        marginStatus: "ok",
        marginCalls: [],
        intradayDeficits: [],
        marginRestrictedUntil: null,
        shortingEnabled: trade.shorting_enabled === true,
        shortingBlockedReason: trade.shorting_enabled ? null : "Short selling isn't enabled for this account",
        unrealizedPnl: roundCents(unrealized),
        missingPrices: [],
        realizedPnl: ledger.realizedPnl,
        netDividends: ledger.netDividends,
        positions: ledger.positions.map(({ ticker, quantity }) => ({ ticker, quantity })),
        liquidations: [],
        pendingTransferOut: ledger.pendingTransferOut,
        withdrawableCash: money(trade.cash_withdrawable),
        unsettledProceeds: ledger.unsettledProceeds,
        accruedFees: ledger.accruedFees
    };
};

// The open lots the replay leaves, as the Lots button shows them
export const taxLotsOf = (replay: Pick<Replay, "lots">, symbol?: string, now = new Date().toISOString()): TaxLot[] =>
    replay.lots.filter(lot => !symbol || lot.symbol === symbol)
        .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.acquiredAt.localeCompare(b.acquiredAt))
        .map(lot => ({
            id: lot.id, symbol: lot.symbol, side: lot.side, qty: lot.qty, originalQty: lot.originalQty, price: lot.price,
            costBasis: roundCents(lot.qty * lot.price), acquiredAt: lot.acquiredAt, longTerm: isLongTerm(lot.acquiredAt, now)
        }));

// The year's gains and losses report (the 1099 figures so far, with wash sales) and the open lots' unrealized gains, from the replay
// and the cash activities
export const taxReportOf = ({ replay, activities, year, prices, now = new Date().toISOString() }: {
    replay: Replay; activities: Activity[]; year: number; prices: Map<string, number>; now?: string;
}) => {
    const { sales, adjustments } = reportSales(replay.acquisitions, replay.disposals);
    // WH (withholding) is Alpaca's type, though the spec's ActivityType enum leaves it out
    const cash = activities as unknown as { activity_type?: string; activity_sub_type?: string; net_amount?: string; date?: string; created_at?: string; description?: string }[];
    const dated = (activity: { date?: string; created_at?: string }) => activity.date ?? String(activity.created_at ?? "").slice(0, 10);
    const figures: TaxYear = taxYear({
        year, sales,
        dividends: cash.filter(activity => String(activity.activity_type).startsWith("DIV") && activity.activity_sub_type !== "SDIV").map(activity => ({ date: dated(activity), amount: Number(activity.net_amount) })),
        interest: cash.filter(activity => activity.activity_type === "INT" && Number(activity.net_amount) > 0).map(activity => ({ date: dated(activity), amount: Number(activity.net_amount) })),
        withholding: cash.filter(activity => activity.activity_type === "WH").map(activity => ({
            date: dated(activity), amount: -Number(activity.net_amount), on: /div/i.test(activity.description ?? "") ? "dividends" as const : "proceeds" as const
        }))
    });
    const unrealized = [...replay.lots].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.acquiredAt.localeCompare(b.acquiredAt)).flatMap(lot => unrealizedRows(
        { id: lot.id, symbol: lot.symbol, side: lot.side, qty: lot.qty, price: lot.price, acquiredAt: lot.acquiredAt },
        adjustments.get(lot.id), prices.get(lot.symbol) ?? null, now
    ));
    return { ...figures, unrealized };
};

// The fills of an order and of the orders it replaced, newest first, by following replaces through the broker
export const orderFillRows = async (broker: Pick<Broker, "getOrder" | "listActivities">, accountId: string, orderId: string, userId: string): Promise<TradeHistoryRow[]> => {
    const fills: BrokerFill[] = [];
    let id: string | null | undefined = orderId;
    for (let depth = 0; id && depth < 20; depth++) {
        const order = await broker.getOrder(accountId, id);
        fills.push(...fillsOf(await broker.listActivities(accountId, { activity_types: "FILL", order_id: id, direction: "asc", page_size: PAGE_SIZE } as never)));
        id = order.replaces;
    }
    fills.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return transactionRowsOf(fills, { realizedByFill: new Map() }, userId);
};

