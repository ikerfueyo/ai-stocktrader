import "server-only";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { findAsset } from "../../assets";
import { fetchPrices } from "../../marketData";
import { getMarketStatus } from "../../market";
import { roundCents } from "../../account";
import { easternParts } from "../../../marketHours";
import { ledgerState } from "./positions";
import { computeMargin, effectiveMultiplier, shortingBlocked, type MarginPosition, type MarginState, type Session } from "./margin";
import { intradayMarginLevel, restrictionActive } from "./intradayMargin";
import { reservedForOrders } from "./matching";
import { toTradeAccount } from "./tradeAccount";
import { BROKER_MAX_MULTIPLIER } from "./kyc";
import type { SimAccountRow, SimOrderRow } from "./shapes";
import type { AssetRow } from "../../universe";
import type { TradeAccount } from "../types";
import type { Quote } from "../../../types";

// The simulator's margin account: the margin figures (./margin.ts) of an account's ledger at current quotes, with what its open
// orders hold back and its open margin calls, for the trading account, buying-power checks, withdrawals and the margin jobs.

type Db = PoolClient | typeof pool;
const LABEL = "Sim margin";
const dayOf = (date: Date) => easternParts(date).dateKey;

// Orders still open, which hold back buying power (held legs don't, but are listed)
export const OPEN_ORDER_STATUSES = ["new", "accepted", "partially_filled", "held", "pending_new", "pending_cancel", "pending_replace"];

// For local testing without Alpaca's flags: SIM_HTB_SYMBOLS=AAA,BBB treats those symbols as hard to borrow
const HTB_SYMBOLS = new Set((process.env.SIM_HTB_SYMBOLS ?? "").split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean));

// Whether a symbol is hard to borrow (Alpaca's borrow_status; without Alpaca's flags everything is easy to borrow)
export const hardToBorrow = (symbol: string, asset: Pick<AssetRow, "borrowStatus"> | null | undefined): boolean =>
    HTB_SYMBOLS.has(symbol.toUpperCase()) || asset?.borrowStatus === "hard_to_borrow";

export interface MarginCallRow {
    id: string; account_id: string; type: "maintenance" | "regt"; amount: string; date: string; issued_at: Date; due_at: Date;
    status: "open" | "met" | "liquidated"; resolved_at: Date | null; created_at: Date;
}

// The account's margin calls that have been issued and are still open
export const openCalls = async (db: Db, accountId: string, now = new Date()): Promise<MarginCallRow[]> =>
    (await db.query<MarginCallRow>(
        `SELECT *, "date"::text AS "date" FROM sim_margin_calls WHERE account_id = $1 AND status = 'open' AND issued_at <= $2 ORDER BY due_at`, [accountId, now]
    )).rows;

export const accountRow = async (db: Db, accountId: string): Promise<SimAccountRow> => {
    const { rows: [row] } = await db.query<SimAccountRow>("SELECT * FROM sim_accounts WHERE id = $1", [accountId]);
    if (!row) throw new BrokerError(404, 40410000, `account not found for ${accountId}`);
    return row;
};

const hasMarginAgreement = (row: Pick<SimAccountRow, "agreements">) => row.agreements.some(({ agreement }) => agreement === "margin_agreement");

// The multiplier the account allows: 1 without the margin agreement, else its max_margin_multiplier, unset the broker's limit
export const maxMultiplierOf = (row: Pick<SimAccountRow, "agreements" | "configurations">): number =>
    hasMarginAgreement(row) ? Math.max(1, Math.min(BROKER_MAX_MULTIPLIER, Number(row.configurations?.max_margin_multiplier ?? BROKER_MAX_MULTIPLIER))) : 1;

export interface MarginSnapshot {
    row: SimAccountRow;
    ledger: Ledger;
    // Cash less queued withdrawals, which are held from the moment they're requested
    cash: number;
    positions: MarginPosition[];
    assets: Record<string, AssetRow | null>;
    quotes: Record<string, Quote>;
    // Positions without a current quote (valued at their last known price, or their cost)
    staleTickers: string[];
    reserved: number;
    state: MarginState;
    calls: MarginCallRow[];
    session: Session;
    // Why the account can't open shorts now, or null
    shortingBlocked: string | null;
    withdrawable: number;
    // What could move within the broker (Alpaca's cash_transferable): withdrawable with held deposits counted
    transferable: number;
    // Intraday margin deficits still outstanding, and the last day of a 90-day restriction in force (null if none)
    intradayDeficits: IntradayDeficitRow[];
    restrictedUntil: string | null;
}

// What the account's open orders hold back from buying power (reservedForOrders), leaving out exceptIds
export const reservedCash = async (db: Db, accountId: string, { positions, multiplier, exceptIds = [] }: { positions: { ticker: string; quantity: number }[]; multiplier: number; exceptIds?: string[] }): Promise<number> => {
    const { rows } = await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE account_id = $1 AND status = ANY($2)", [accountId, OPEN_ORDER_STATUSES]);
    const open = rows.filter(({ id, parent_id }) => !exceptIds.includes(id) && !(parent_id && exceptIds.includes(parent_id)));
    if (open.length === 0) return 0;
    const symbols = [...new Set(open.map(({ symbol }) => symbol))];
    const unpriced = [...new Set(open.filter(row => row.limit_price === null && row.stop_price === null && row.notional === null).map(({ symbol }) => symbol))];
    const [{ quotes }, assets] = await Promise.all([
        unpriced.length > 0 ? fetchPrices(unpriced, LABEL) : { quotes: {} as Record<string, Quote> },
        Promise.all(symbols.map(async symbol => [symbol, (await findAsset(symbol))?.marginable ?? null] as const))
    ]);
    const num = (value: string | null) => value === null ? null : Number(value);
    return reservedForOrders(
        open.map(row => ({
            symbol: row.symbol, side: row.side, limitPrice: num(row.limit_price), stopPrice: num(row.stop_price), qty: num(row.qty), notional: num(row.notional),
            filledQty: Number(row.filled_qty), filledNotional: Number(row.filled_notional), held: row.status === "held"
        })),
        Object.fromEntries(positions.map(({ ticker, quantity }) => [ticker, quantity])),
        quotes,
        { marginable: Object.fromEntries(assets), multiplier }
    );
};

type Ledger = Awaited<ReturnType<typeof ledgerState>>;

// A position's margin flags from its asset. A stock that has left the universe (null: delisted, moved to OTC as liquidation-only, as
// Alpaca handles it) is non-marginable, so whatever price it's valued at can't be borrowed against; while the universe has never been
// synced (undefined), nothing is known.
const marginAssetOf = (asset: AssetRow | null | undefined): MarginPosition["asset"] => {
    if (asset) return { marginable: asset.marginable, marginRequirementLong: asset.marginRequirementLong, marginRequirementShort: asset.marginRequirementShort };
    return asset === null ? { marginable: false, marginRequirementLong: null, marginRequirementShort: null } : null;
};

// The ledger's positions at current quotes (a position without one at its last known price, or its cost), with their assets' margin
// flags
const valuePositions = async (ledger: Ledger) => {
    const symbols = ledger.positions.map(({ ticker }) => ticker);
    const [{ quotes, prices, staleTickers }, assetList] = await Promise.all([
        symbols.length > 0 ? fetchPrices(symbols, LABEL) : { quotes: {} as Record<string, Quote>, prices: {} as Record<string, number>, staleTickers: [] as string[] },
        Promise.all(symbols.map(async symbol => [symbol, await findAsset(symbol)] as const))
    ]);
    const assets = Object.fromEntries(assetList.map(([symbol, asset]) => [symbol, asset ?? null]));
    const found = Object.fromEntries(assetList);
    const positions: MarginPosition[] = ledger.positions.map(({ ticker, quantity, avgCost }) => ({
        symbol: ticker, qty: quantity, price: prices[ticker] ?? avgCost,
        asset: marginAssetOf(found[ticker])
    }));
    return { symbols, quotes, prices, staleTickers, assets, positions, cash: roundCents(ledger.cash - ledger.pendingTransferOut) };
};

// The account's intraday margin level now (FINRA Rule 4210(a)(17)): equity less the maintenance requirement at current quotes, or
// null for an account that isn't a margin account (cash accounts and IRAs, which the rule leaves out)
export const marginLevel = async (db: Db, accountId: string, now = new Date()): Promise<number | null> => {
    if (maxMultiplierOf(await accountRow(db, accountId)) <= 1) return null;
    const { positions, cash } = await valuePositions(await ledgerState(db, accountId, now));
    return intradayMarginLevel(computeMargin({ cash, positions, maxMultiplier: 1, session: "closed" }));
};

export interface IntradayDeficitRow {
    id: string; account_id: string; date: string; amount: string; equity: string; start_level: string; de_minimis: boolean; restrict_on: string; expire_on: string;
    issued_at: Date; status: "open" | "met" | "expired"; met_at: Date | null; missed: boolean; restricted_until: string | null; created_at: Date;
}

export const DEFICIT_COLUMNS = `*, "date"::text AS "date", restrict_on::text AS restrict_on, expire_on::text AS expire_on, restricted_until::text AS restricted_until`;

// The account's intraday margin deficits still outstanding, and the last day of a 90-day restriction in force on dateKey (null if none)
export const intradayStatus = async (db: Db, accountId: string, dateKey: string) => {
    const { rows } = await db.query<IntradayDeficitRow>(
        `SELECT ${DEFICIT_COLUMNS} FROM sim_intraday_deficits WHERE account_id = $1 AND met_at IS NULL AND (status = 'open' OR restricted_until >= $2) ORDER BY sim_intraday_deficits."date"`,
        [accountId, dateKey]
    );
    const restrictedUntil = rows.filter(row => restrictionActive({ restrictedUntil: row.restricted_until, metAt: row.met_at }, dateKey))
        .map(({ restricted_until }) => restricted_until!).sort().at(-1) ?? null;
    return { deficits: rows.filter(({ status }) => status === "open"), restrictedUntil };
};

// Why the account can't borrow more or short now under a 90-day intraday margin restriction
export const restrictionReason = (restrictedUntil: string) =>
    `An intraday margin deficit went unmet past its 5th business day, so until ${restrictedUntil} new short sales and borrowing aren't allowed (FINRA Rule 4210(d)(2))`;

// The account's margin now: its ledger valued at current quotes (a position without one at its last known price, or its cost), with
// its assets' margin flags, the buying power its open orders hold back (but exceptOrderIds) and its open calls. session defaults to
// the market's now. Under a 90-day intraday margin restriction the account trades at 1x and can't short.
export const marginSnapshot = async (db: Db, accountId: string, { exceptOrderIds = [], session, now = new Date() }: { exceptOrderIds?: string[]; session?: Session; now?: Date } = {}): Promise<MarginSnapshot> => {
    const row = await accountRow(db, accountId);
    const ledger = await ledgerState(db, accountId, now);
    const [{ symbols, quotes, prices, staleTickers, assets, positions, cash }, market, calls] = await Promise.all([
        valuePositions(ledger),
        session ? null : getMarketStatus(),
        openCalls(db, accountId, now)
    ]);
    const intraday = await intradayStatus(db, accountId, dayOf(now));
    const sessionNow = session ?? (market!.session as Session);
    const maxMultiplier = intraday.restrictedUntil ? 1 : maxMultiplierOf(row);
    const unreserved = computeMargin({ cash, positions, maxMultiplier, session: sessionNow });
    const reserved = await reservedCash(db, accountId, { positions: ledger.positions, multiplier: unreserved.multiplier, exceptIds: exceptOrderIds });
    const state = computeMargin({ cash, positions, maxMultiplier, session: sessionNow, reserved });
    // Withdrawable: settled cash (less instant credit and sale proceeds not yet settled, and deposits the broker still holds), no more
    // than the excess over Reg T initial margin less what open orders hold, and nothing during a margin call. Transferable is the same
    // with held deposits counted, as Alpaca's cash_transferable (for journals) counts them.
    const settledCash = cash - ledger.unsettledInstant - ledger.unsettledProceeds;
    const excess = unreserved.sma - reserved / Math.max(1, unreserved.multiplier);
    const available = (settled: number) => calls.length > 0 ? 0 : Math.max(0, roundCents(Math.min(settled, excess)));
    const withdrawable = available(settledCash - ledger.heldDeposits);
    const transferable = available(settledCash);
    return {
        row, ledger, cash, positions, assets, quotes, staleTickers: staleTickers.filter(ticker => symbols.includes(ticker)).concat(symbols.filter(symbol => prices[symbol] === undefined)),
        reserved, state, calls, session: sessionNow,
        shortingBlocked: row.account_type === "ira" ? "IRAs can't sell short"
            : intraday.restrictedUntil ? restrictionReason(intraday.restrictedUntil)
            : shortingBlocked({ hasMarginAgreement: hasMarginAgreement(row), noShorting: row.configurations?.no_shorting === true, equity: state.equity }),
        withdrawable, transferable, intradayDeficits: intraday.deficits, restrictedUntil: intraday.restrictedUntil
    };
};

// Why a withdrawal of amount (plus any fee) can't go ahead, or null: not during a margin call, not on stale short prices, and no more
// than withdrawable
export const withdrawalError = (snapshot: MarginSnapshot, amount: number): { status: number; message: string } | null => {
    const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (snapshot.calls.length > 0) {
        const total = snapshot.calls.reduce((sum, call) => sum + Number(call.amount), 0);
        return { status: 400, message: `Margin call: your account has a ${money(total)} margin call, so withdrawals wait until it's met` };
    }
    const unpriced = snapshot.positions.filter(({ symbol, qty }) => qty < 0 && snapshot.staleTickers.includes(symbol)).map(({ symbol }) => symbol);
    if (unpriced.length > 0) return { status: 502, message: `Couldn't get a current price for ${unpriced.join(", ")} to check margin; try again shortly` };
    if (amount > snapshot.withdrawable + 0.005) {
        return { status: 400, message: `Insufficient funds: can't withdraw ${money(amount)}, only ${money(snapshot.withdrawable)} is withdrawable` };
    }
    return null;
};

// GET /v1/trading/accounts/{id}/account: the margin snapshot in Alpaca's shape, with the last end-of-day balances as the last_* fields
export const getTradeAccount = async (accountId: string): Promise<TradeAccount> => {
    const snapshot = await marginSnapshot(pool, accountId);
    const { row, ledger, state } = snapshot;
    const { rows: [last] } = await pool.query<{ date: string; equity: string; cash: string; long_market_value: string; short_market_value: string; maintenance_margin: string; initial_margin: string | null; buying_power: string | null; regt_buying_power: string | null }>(
        `SELECT "date"::text, equity, cash, long_market_value, short_market_value, maintenance_margin, initial_margin, buying_power, regt_buying_power FROM sim_daily_balances
         WHERE account_id = $1 AND "date" < $2 ORDER BY "date" DESC LIMIT 1`, [accountId, dayOf(new Date())]
    );
    return toTradeAccount({
        account: { ...row, hasMarginAgreement: hasMarginAgreement(row) },
        state: { ...state, cash: ledger.cash },
        // The account's multiplier as Alpaca reports it: its own, or 1 below $2,000 of equity
        multiplier: effectiveMultiplier(state.equity, state.maxMultiplier, "regular"),
        shortingEnabled: snapshot.shortingBlocked === null,
        withdrawable: snapshot.withdrawable,
        transferable: snapshot.transferable,
        accruedFees: ledger.accruedFees,
        pendingTransferOut: ledger.pendingTransferOut,
        last: last ? {
            date: last.date, equity: Number(last.equity), cash: Number(last.cash), longMarketValue: Number(last.long_market_value),
            shortMarketValue: Number(last.short_market_value), maintenanceMargin: Number(last.maintenance_margin),
            initialMargin: last.initial_margin === null ? null : Number(last.initial_margin), buyingPower: last.buying_power === null ? null : Number(last.buying_power),
            regtBuyingPower: last.regt_buying_power === null ? null : Number(last.regt_buying_power)
        } : null
    });
};
