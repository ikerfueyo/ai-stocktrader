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
import { reservedForOrders } from "./matching";
import { toTradeAccount } from "./tradeAccount";
import type { SimAccountRow, SimOrderRow } from "./shapes";
import type { AssetRow } from "../../universe";
import type { TradeAccount } from "../types";
import type { Quote } from "../../../types";

// The simulator's margin account: the margin figures (./margin.ts) of an account's ledger at current quotes, with what its open
// orders hold back and its open margin calls, for the trading account, buying-power checks, withdrawals and the margin jobs.

type Db = PoolClient | typeof pool;
const LABEL = "Sim margin";

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

// The multiplier the account allows: 1 without the margin agreement, else its max_margin_multiplier
export const maxMultiplierOf = (row: Pick<SimAccountRow, "agreements" | "configurations">): number =>
    hasMarginAgreement(row) ? Math.max(1, Number(row.configurations?.max_margin_multiplier ?? 2)) : 1;

export interface MarginSnapshot {
    row: SimAccountRow;
    ledger: Awaited<ReturnType<typeof ledgerState>>;
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
}

// What the account's open orders hold back from buying power (reservedForOrders), leaving out exceptIds
export const reservedCash = async (db: Db, accountId: string, { positions, multiplier, exceptIds = [] }: { positions: { ticker: string; quantity: number }[]; multiplier: number; exceptIds?: string[] }): Promise<number> => {
    const { rows } = await db.query<SimOrderRow>("SELECT * FROM sim_orders WHERE account_id = $1 AND status = ANY($2)", [accountId, OPEN_ORDER_STATUSES]);
    const open = rows.filter(({ id }) => !exceptIds.includes(id));
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

// The account's margin now: its ledger valued at current quotes (a position without one at its last known price, or its cost), with
// its assets' margin flags, the buying power its open orders hold back (but exceptOrderIds) and its open calls. session defaults to
// the market's now.
export const marginSnapshot = async (db: Db, accountId: string, { exceptOrderIds = [], session, now = new Date() }: { exceptOrderIds?: string[]; session?: Session; now?: Date } = {}): Promise<MarginSnapshot> => {
    const row = await accountRow(db, accountId);
    const ledger = await ledgerState(db, accountId, now);
    const symbols = ledger.positions.map(({ ticker }) => ticker);
    const [{ quotes, prices, staleTickers }, assetList, market, calls] = await Promise.all([
        symbols.length > 0 ? fetchPrices(symbols, LABEL) : { quotes: {} as Record<string, Quote>, prices: {} as Record<string, number>, staleTickers: [] as string[] },
        Promise.all(symbols.map(async symbol => [symbol, (await findAsset(symbol)) ?? null] as const)),
        session ? null : getMarketStatus(),
        openCalls(db, accountId, now)
    ]);
    const assets = Object.fromEntries(assetList);
    const positions: MarginPosition[] = ledger.positions.map(({ ticker, quantity, avgCost }) => ({
        symbol: ticker, qty: quantity, price: prices[ticker] ?? avgCost,
        asset: assets[ticker] ? { marginable: assets[ticker]!.marginable, marginRequirementLong: assets[ticker]!.marginRequirementLong, marginRequirementShort: assets[ticker]!.marginRequirementShort } : null
    }));
    const cash = roundCents(ledger.cash - ledger.pendingTransferOut);
    const sessionNow = session ?? (market!.session as Session);
    const maxMultiplier = maxMultiplierOf(row);
    const unreserved = computeMargin({ cash, positions, maxMultiplier, session: sessionNow });
    const reserved = await reservedCash(db, accountId, { positions: ledger.positions, multiplier: unreserved.multiplier, exceptIds: exceptOrderIds });
    const state = computeMargin({ cash, positions, maxMultiplier, session: sessionNow, reserved });
    // Withdrawable: settled cash (less instant credit and sale proceeds not yet settled), no more than the excess over Reg T initial
    // margin less what open orders hold, and nothing during a margin call
    const settledCash = cash - ledger.unsettledInstant - ledger.unsettledProceeds;
    const withdrawable = calls.length > 0 ? 0 : Math.max(0, roundCents(Math.min(settledCash, unreserved.sma - reserved / Math.max(1, unreserved.multiplier))));
    return {
        row, ledger, cash, positions, assets, quotes, staleTickers: staleTickers.filter(ticker => symbols.includes(ticker)).concat(symbols.filter(symbol => prices[symbol] === undefined)),
        reserved, state, calls, session: sessionNow,
        shortingBlocked: shortingBlocked({ hasMarginAgreement: hasMarginAgreement(row), noShorting: row.configurations?.no_shorting === true, equity: state.equity }),
        withdrawable
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

const dayOf = (date: Date) => easternParts(date).dateKey;

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
