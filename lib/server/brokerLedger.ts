// The app's view of an account read through the Broker interface alone, for brokers whose ledger the app can't query (BROKER=alpaca;
// with the simulator, lib/server/portfolio.ts reads its richer ledger directly). Everything comes from Alpaca's endpoints: positions,
// the trading account, and the account's activities, whose fills are replayed FIFO with the stored splits (replayFills) for what
// Alpaca doesn't report: realized P&L per fill, open tax lots and the year's gains and losses (its 1099 is the record). Kept free of
// the database and server-only modules, so it's tested with a fake broker, and the scenarios check it against SimBroker.
import { easternParts, settlementDate } from "../marketHours";
import { contractMultiplier } from "../options";
import { applyFill, applySplit, isLongTerm, type Lot } from "./broker/sim/ledger";
import { reportSales, taxYear, termOf, type Acquisition, type Disposal, type TaxYear } from "./broker/sim/tax";
import { totalOptionRequirement } from "./broker/sim/options";
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

// Replays the fills FIFO (lib/server/broker/sim/ledger.ts's applyFill), applying each split to the lots acquired before its ex-date,
// as Alpaca's activities keep their pre-split terms. Other corporate actions (mergers, spinoffs) and option exercises aren't replayed,
// so after one the lots are approximate; the broker's positions stay the source of what's held.
export const replayFills = (fills: BrokerFill[], splits: Split[], today = easternParts(new Date()).dateKey): Replay => {
    const lots = new Map<string, ReplayedLot[]>();
    const applied = new Set<string>();
    const realizedByFill = new Map<string, number | null>();
    const acquisitions: Acquisition[] = [];
    const disposals: Disposal[] = [];
    const original = new Map<string, number>();
    let realized = 0;
    // The splits of a symbol that took effect by the day, onto the lots acquired before them
    const splitThrough = (symbol: string, day: string) => {
        for (const split of splits) {
            const key = `${split.ticker}|${split.exDate}`;
            if (split.ticker.toUpperCase() !== symbol || split.exDate > day || applied.has(key)) continue;
            applied.add(key);
            const open = lots.get(symbol) ?? [];
            const before = open.filter(lot => dayOf(lot.acquiredAt) < split.exDate);
            const split_ = applySplit(before, split.factor);
            lots.set(symbol, [...open.filter(lot => !before.includes(lot)), ...split_.map(lot => ({ ...lot, originalQty: (original.get(lot.id) ?? lot.qty) * split.factor }))]);
            for (const lot of split_) original.set(lot.id, (original.get(lot.id) ?? lot.qty) * split.factor);
            // The acquisitions are kept in today's terms, as the wash sale rule compares shares
            for (const acquisition of acquisitions) if (acquisition.symbol === symbol && dayOf(acquisition.acquiredAt) < split.exDate) acquisition.qty *= split.factor;
        }
    };
    for (const fill of fills) {
        splitThrough(fill.symbol, dayOf(fill.at));
        const multiplier = contractMultiplier(fill.symbol);
        const open = lots.get(fill.symbol) ?? [];
        const result = applyFill(open, { side: fill.side, qty: fill.qty, price: fill.price, at: fill.at }, `lot-${fill.id}`, fill.symbol, multiplier);
        const byId = new Map(open.map(lot => [lot.id, lot]));
        for (const closing of result.closings) {
            const lot = byId.get(closing.lotId)!;
            disposals.push({
                id: `${fill.id}|${closing.lotId}`, lotId: closing.lotId, symbol: fill.symbol, side: lot.side, qty: closing.qty * multiplier, lotPrice: closing.price, price: fill.price,
                acquiredAt: lot.acquiredAt, closedAt: fill.at, kind: "sale"
            });
        }
        if (result.opened) {
            original.set(result.opened.id, result.opened.qty);
            acquisitions.push({ lotId: result.opened.id, symbol: fill.symbol, side: result.opened.side, qty: result.opened.qty * multiplier, acquiredAt: fill.at });
        }
        lots.set(fill.symbol, result.lots.map(lot => ({ ...lot, originalQty: original.get(lot.id) ?? lot.qty })));
        realizedByFill.set(fill.id, result.closings.length > 0 ? roundCents(result.realized) : null);
        realized += result.realized;
    }
    for (const symbol of lots.keys()) splitThrough(symbol, today);
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
    total: (fill.qty * fill.price * contractMultiplier(fill.symbol)).toFixed(2), date: new Date(fill.at)
}));

// Fills as the Trades tab's rows, newest first, with the P&L the replay found and their settlement (T+1)
export const transactionRowsOf = (fills: BrokerFill[], replay: Pick<Replay, "realizedByFill">, userId: string): TradeHistoryRow[] =>
    [...fills].reverse().map(fill => ({
        id: fill.id, user_id: userId, date: fill.at, type: fill.side === "buy" ? "BUY" : "SELL", ticker: fill.symbol, price: String(fill.price), quantity: String(fill.qty),
        total: (fill.qty * fill.price * contractMultiplier(fill.symbol)).toFixed(2), reason: null, quote_time: null, fill_policy: null, order_id: fill.orderId,
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
export const ledgerOf = ({ trade, positions, activities, splits, today = easternParts(new Date()).dateKey }: {
    trade: TradeAccount; positions: BrokerPosition[]; activities: Activity[]; splits: Split[]; today?: string;
}) => {
    const fills = fillsOf(activities);
    const replay = replayFills(fills, splits, today);
    const cash = cashRowsOf(activities, "");
    // Sales that settle after today (T+1): tradable, not yet withdrawable
    const unsettledProceeds = roundCents(fills.filter(fill => fill.side === "sell" && settlementDate(dayOf(fill.at)) > today)
        .reduce((sum, fill) => sum + fill.qty * fill.price * contractMultiplier(fill.symbol), 0));
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
    const optionsApproved = Number(trade.options_approved_level ?? 0);
    const unrealized = positions.reduce((sum, position) => sum + Number(position.unrealized_pl ?? 0), 0);
    return {
        totalCash: ledger.totalCash,
        optionsBuyingPower: money(trade.options_buying_power),
        optionRequirement: roundCents(totalOptionRequirement(positions.map(position => ({ symbol: String(position.symbol), qty: Number(position.qty) })))),
        optionsLevel: Number(trade.options_trading_level ?? Math.min(optionsApproved, Number(configurations.max_options_trading_level ?? optionsApproved))),
        optionsApprovedLevel: optionsApproved,
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
            costBasis: roundCents(lot.qty * lot.price * contractMultiplier(lot.symbol)), acquiredAt: lot.acquiredAt, longTerm: isLongTerm(lot.acquiredAt, now)
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
    const unrealized = replay.lots.map(lot => {
        const shares = lot.qty * contractMultiplier(lot.symbol);
        const adjustment = adjustments.get(lot.id);
        const wash = adjustment ? adjustment.basis * lot.qty / lot.originalQty : 0;
        const basis = roundCents(shares * lot.price + wash);
        const price = prices.get(lot.symbol) ?? null;
        const value = price === null ? null : roundCents(shares * price);
        const dateAcquired = adjustment ? new Date(Date.parse(lot.acquiredAt) - adjustment.carriedDays * 86400000).toISOString() : lot.acquiredAt;
        return {
            id: lot.id, symbol: lot.symbol, side: lot.side, qty: lot.qty, acquiredAt: lot.acquiredAt, dateAcquired, price: lot.price, costBasis: basis,
            washAdjustment: roundCents(wash), marketValue: value, unrealized: value === null ? null : roundCents(lot.side === "long" ? value - basis : basis - value),
            term: lot.side === "long" ? termOf(dateAcquired, now) : "short" as const
        };
    }).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.acquiredAt.localeCompare(b.acquiredAt));
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

