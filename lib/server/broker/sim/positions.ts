import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { fetchQuotes } from "../../marketData";
import { findAsset } from "../../assets";
import { planDividends, roundCents, type Dividend, type Split, type Trade } from "../../account";
import { easternParts, easternTime, settlementDate } from "../../../marketHours";
import { emitEvent } from "./accounts";
import { withhold } from "./withholding";
import { activityId, ledgerCash, postActivity } from "./transfers";
import { applyFill, isLongTerm, positionsFromLots, type Lot } from "./ledger";
import { applyActionToLots, type CorporateAction, type CorporateActionType, type LotEffect } from "./corporateActions";
import { FEE_DESCRIPTIONS, feesFor, roundFeeUp, type FeeAccrual } from "./feeSchedule";
import { assetId, type SimAccountRow, type SimActivityRow } from "./shapes";
import { contractMultiplier, contractName } from "../../../options";
import { toAlpacaPosition } from "./tradeAccount";
import type { Position as AlpacaPosition } from "../types";
import type { Position, Quote } from "../../../types";

// The simulator's trade ledger: fills post FILL activities that close and open FIFO tax lots (sim_lots, the positions' only source),
// realize P&L against the lots they close, settle T+1 and accrue regulatory fees; corporate actions adjust, move and close the lots
// and dividends post DIV activities, each once per account; the end of the day deducts the fees and keeps the closing balances. The caller holds the account
// lock and runs fills inside a transaction (the app's withAccountLock and inTransaction).

type Db = PoolClient | typeof pool;

interface LotRow {
    id: string; account_id: string; symbol: string; side: "long" | "short"; qty: string; original_qty: string; price: string; acquired_at: Date;
    fill_id: string; wash_sale_adjustment: string;
}

const toLot = (row: LotRow): Lot => ({ id: row.id, symbol: row.symbol, side: row.side, qty: Number(row.qty), price: Number(row.price), acquiredAt: row.acquired_at.toISOString() });

export const openLots = async (db: Db, accountId: string, symbol?: string): Promise<Lot[]> =>
    (await db.query<LotRow>(
        "SELECT * FROM sim_lots WHERE account_id = $1 AND qty > 0 AND ($2::text IS NULL OR symbol = $2) ORDER BY acquired_at, id", [accountId, symbol ?? null]
    )).rows.map(toLot);

const dayOf = (date: Date | string) => easternParts(new Date(date)).dateKey;

// For local testing: SIM_CASH_IN_LIEU=true pays out the fractional share a split, stock dividend, merger or spinoff leaves, instead of
// keeping it (Alpaca supports fractional shares, so the default keeps it)
const CASH_IN_LIEU = process.env.SIM_CASH_IN_LIEU === "true";

export interface ActionRow { ticker: string; type: CorporateActionType; ex_date: string; factor: string | null; amount: string | null; new_ticker: string | null }

export const toAction = (row: ActionRow): CorporateAction => ({
    type: row.type, symbol: row.ticker, newSymbol: row.new_ticker, factor: row.factor === null ? null : Number(row.factor), cash: row.amount === null ? null : Number(row.amount), exDate: row.ex_date
});

// Applies the stored corporate actions of these symbols whose effective date has come to the account's lots acquired before it, once
// each, oldest first (applyActionToLots): the activities it posts (SPLIT, DIV SDIV, MA, SPIN, REORG, CIL, with the P&L each realizes),
// the lots' new shares, prices and symbols, the new lots of a spinoff, and what each closing realized. An action that moves shares to
// a new symbol (a merger, a symbol change) brings that symbol's later actions along. Cash dividends post on their payment date
// instead (postDividends). Runs before every fill in the symbol, so a fill never closes lots in pre-action shares; without a
// transaction of the caller's, it runs in its own, holding the account lock.
export const applyCorporateActions = async (db: Db, accountId: string, symbols: string[], now = new Date()): Promise<void> => {
    if (symbols.length === 0) return;
    if (db === pool) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await lockAccount(client, accountId);
            await applyCorporateActions(client, accountId, symbols, now);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        return;
    }
    const queue = [...new Set(symbols.map(symbol => symbol.toUpperCase()))];
    const seen = new Set(queue);
    while (queue.length > 0) {
        const { rows } = await db.query<ActionRow>(
            `SELECT ticker, "type", ex_date::text, factor, amount, new_ticker FROM corporate_actions c
             WHERE "type" <> 'DIVIDEND' AND ticker = ANY($1) AND ex_date <= $2
               AND NOT EXISTS (SELECT 1 FROM sim_corporate_actions_applied a WHERE a.account_id = $3 AND a.symbol = c.ticker AND a."type" = c."type" AND a.ex_date = c.ex_date)
             ORDER BY ex_date, ticker`,
            [queue.splice(0, queue.length), dayOf(now), accountId]
        );
        for (const row of rows) {
            const action = toAction(row);
            const before = (await openLots(db, accountId, row.ticker)).filter(lot => dayOf(lot.acquiredAt) < row.ex_date);
            if (before.length > 0) {
                const needsPrices = CASH_IN_LIEU || row.type === "SPINOFF" || row.type === "MIXED_MERGER";
                const [own, other] = needsPrices
                    ? await Promise.all([row.ticker, row.new_ticker].map(symbol => symbol ? fetchQuotes([symbol])[0].then(quote => quote.price, () => null) : Promise.resolve(null)))
                    : [null, null];
                const effect = applyActionToLots(before, action, { prices: { symbol: own, newSymbol: other }, cashInLieu: CASH_IN_LIEU });
                await postLotEffect(db as PoolClient, accountId, before, effect, easternTime(row.ex_date, "09:30"));
                if (row.new_ticker && !seen.has(row.new_ticker)) {
                    seen.add(row.new_ticker);
                    queue.push(row.new_ticker);
                }
            }
            await db.query(`INSERT INTO sim_corporate_actions_applied (account_id, symbol, "type", ex_date) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [accountId, row.ticker, row.type, row.ex_date]);
        }
    }
};

// Applies the corporate actions that have taken effect to every account holding their symbols (the corporate-actions job; reading an
// account or filling in a symbol applies them too). Returns how many accounts it looked at.
export const applyDueCorporateActions = async (now = new Date()): Promise<number> => {
    const { rows } = await pool.query<{ account_id: string; symbols: string[] }>(
        `SELECT l.account_id, array_agg(DISTINCT l.symbol) AS symbols FROM sim_lots l JOIN corporate_actions c ON c.ticker = l.symbol
         WHERE l.qty > 0 AND c."type" <> 'DIVIDEND' AND c.ex_date <= $1 AND l.acquired_at < (c.ex_date::timestamp AT TIME ZONE 'America/New_York')
           AND NOT EXISTS (SELECT 1 FROM sim_corporate_actions_applied a WHERE a.account_id = l.account_id AND a.symbol = c.ticker AND a."type" = c."type" AND a.ex_date = c.ex_date)
         GROUP BY l.account_id`,
        [dayOf(now)]
    );
    for (const { account_id, symbols } of rows) {
        await applyCorporateActions(pool, account_id, symbols, now).catch(error => console.error(`Corporate actions for ${account_id}: ${error.message}`));
    }
    return rows.length;
};

// Writes an action's effect: its activities (with the P&L the closings under each realize), the lots' new state (original_qty
// scaled with the shares, so a split or merger keeps it in today's terms), the new lots, and the closings
const postLotEffect = async (db: PoolClient, accountId: string, lots: Lot[], effect: LotEffect, at: Date) => {
    const activityIds = new Map<string, string>();
    for (const entry of effect.activities) {
        const realized = effect.closings.filter(({ tag }) => tag === entry.tag).reduce((sum, { realized }) => sum + realized, 0);
        const row = await postActivity(db, { accountId, type: entry.type, subType: entry.subType ?? undefined, netAmount: entry.netAmount, description: entry.description, symbol: entry.symbol, qty: entry.qty, at });
        if (effect.closings.some(({ tag }) => tag === entry.tag)) await db.query("UPDATE sim_activities SET realized_pl = $2 WHERE id = $1", [row.id, roundCents(realized).toFixed(2)]);
        activityIds.set(entry.tag, row.id);
    }
    for (const update of effect.updates) {
        const lot = lots.find(({ id }) => id === update.id)!;
        const scale = lot.qty > 0 && update.qty > 0 ? update.qty / lot.qty : 1;
        await db.query("UPDATE sim_lots SET qty = $2, price = $3, symbol = $4, original_qty = original_qty * $5 WHERE id = $1", [update.id, update.qty, update.price, update.symbol, scale]);
    }
    const openedIds: string[] = [];
    for (const lot of effect.opened) {
        const id = randomUUID();
        openedIds.push(id);
        await db.query(
            `INSERT INTO sim_lots (id, account_id, symbol, side, qty, original_qty, price, acquired_at, fill_id) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
            [id, accountId, lot.symbol, lot.side, lot.qty, lot.price, lot.acquiredAt, activityIds.get("spin") ?? null]
        );
    }
    for (const closing of effect.closings) {
        const lotId = closing.lotId ?? openedIds[closing.openedIndex!];
        const fillId = activityIds.get(closing.tag);
        if (!lotId || !fillId || !(closing.qty > 0)) continue;
        await db.query(
            `INSERT INTO sim_lot_closings (account_id, lot_id, fill_id, qty, lot_price, close_price, realized, closed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [accountId, lotId, fillId, closing.qty, closing.lotPrice, closing.price, roundCents(closing.realized).toFixed(2), at]
        );
    }
};

// The symbol each traded symbol now goes by, after the account's applied symbol changes, with the date each took effect
const appliedRenames = async (db: Db, accountId: string) =>
    (await db.query<{ ticker: string; new_ticker: string; ex_date: string }>(
        `SELECT c.ticker, c.new_ticker, c.ex_date::text FROM sim_corporate_actions_applied a
         JOIN corporate_actions c ON c.ticker = a.symbol AND c."type" = a."type" AND c.ex_date = a.ex_date
         WHERE a.account_id = $1 AND a."type" = 'NAME_CHANGE' ORDER BY c.ex_date`, [accountId]
    )).rows;

// The signed position in a symbol now, from its open lots
export const positionQty = async (db: Db, accountId: string, symbol: string): Promise<number> =>
    positionsFromLots(await openLots(db, accountId, symbol)).find(({ ticker }) => ticker === symbol)?.quantity ?? 0;

// The account's fills as trades to replay (oldest first, quantities as filled), for dividends and the equity history, with the shares
// corporate actions moved as trades at no cost (shares received as buys, removed as sells; their cash is in the cash ledger), option
// contracts an exercise, assignment or expiry closed (likewise), and the trades before a symbol change under the new symbol. Splits are
// replayed from the stored splits.
export const fillsAsTrades = async (db: Db, accountId: string): Promise<Trade[]> => {
    const [{ rows }, renames] = await Promise.all([
        db.query<{ activity_type: string; activity_sub_type: string | null; symbol: string; side: string | null; price: string | null; qty: string; net_amount: string; created_at: Date }>(
            `SELECT activity_type, activity_sub_type, symbol, side, price, qty, net_amount, created_at FROM sim_activities
             WHERE account_id = $1 AND (activity_type = 'FILL' OR (activity_type IN ('MA', 'SPIN', 'REORG', 'CIL', 'OPEXP', 'OPEXC', 'OPASN') AND qty <> 0) OR (activity_type = 'DIV' AND activity_sub_type = 'SDIV'))
             ORDER BY created_at, id`, [accountId]
        ),
        appliedRenames(db, accountId)
    ]);
    return rows.map(row => {
        const date = row.created_at;
        let ticker = row.symbol;
        for (const { ticker: from, new_ticker: to, ex_date } of renames) if (ticker === from && dayOf(date) < ex_date) ticker = to;
        if (row.activity_type === "FILL") {
            return { ticker, type: row.side === "buy" ? "BUY" : "SELL", price: row.price!, quantity: row.qty, total: String(Math.abs(Number(row.net_amount))), date };
        }
        const qty = Number(row.qty);
        return { ticker, type: qty > 0 ? "BUY" : "SELL", price: 0, quantity: Math.abs(qty), total: 0, date };
    });
};

// Posts the dividends paid since they were last checked (planDividends on the replayed fills, with the splits): DIV activities, a
// credit for a long held at the ex-date's open and a charge for a short, dated at the payment date's close, once each
export const postDividends = async (db: Db, accountId: string, corporate: { splits: Split[]; dividends: Dividend[] }, now = new Date()) => {
    const trades = await fillsAsTrades(db, accountId);
    if (trades.length === 0) return [];
    const { rows: postedRows } = await db.query<{ symbol: string; ex_date: string }>(
        `SELECT symbol, ex_date::text FROM sim_corporate_actions_applied WHERE account_id = $1 AND "type" = 'DIVIDEND'`, [accountId]
    );
    const postings = planDividends({ transactions: trades, splits: corporate.splits, dividends: corporate.dividends, posted: new Set(postedRows.map(({ symbol, ex_date }) => `${symbol}|${ex_date}`)), asOf: now });
    const posted: SimActivityRow[] = [];
    for (const { type, ticker, exDate, shares, perShare, total } of postings) {
        const payment = corporate.dividends.find(dividend => dividend.ticker === ticker && dividend.exDate === exDate)?.paymentDate ?? exDate;
        const at = new Date(Math.min(easternTime(payment, "16:00").getTime(), now.getTime()));
        const credit = type === "DIVIDEND_IN";
        if (credit) await withhold(db, accountId, { amount: total, on: "dividends", symbol: ticker, at });
        posted.push(await postActivity(db, {
            accountId, type: "DIV", subType: "CDIV", netAmount: credit ? total : -total, symbol: ticker, qty: shares, perShareAmount: perShare, at,
            description: `${ticker} cash dividend: ${parseFloat(shares.toFixed(6))} ${credit ? "shares" : "shares short (charged)"} × $${perShare}`
        }));
        await db.query(`INSERT INTO sim_corporate_actions_applied (account_id, symbol, "type", ex_date) VALUES ($1, $2, 'DIVIDEND', $3) ON CONFLICT DO NOTHING`, [accountId, ticker, exDate]);
    }
    return posted;
};

export interface FillRequest {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    // What the fill pays or receives, rounded to the cent (qty × price × the contract multiplier for an option)
    total: number;
    // LIQUIDATION for orders meeting a margin call; EXERCISE and ASSIGNMENT for the shares an option delivers
    reason?: "LIQUIDATION" | "EXERCISE" | "ASSIGNMENT";
    // The price the lots use when it differs from the cash price: the strike with an exercised or assigned option's premium rolled in
    lotPrice?: number;
    quoteTime?: string | null;
    fillPolicy?: string;
    legacyOrderId?: number;
    // The order it fills, with its shares filled so far and still to fill after this fill (the order engine emits its trade event)
    orderId?: string;
    cumQty?: number;
    leavesQty?: number;
    at?: Date;
}

// Serializes the simulator's changes to one account's ledger and orders (fills, the order engine, buy-ins) across requests, jobs and
// server processes: a transaction-level advisory lock, released when the caller's transaction ends
export const lockAccount = (db: PoolClient, accountId: string) => db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sim-account:${accountId}`]);

// Records a fill: the FILL activity (cash ± total, the P&L it realizes, settling the next trading day), the lots it closes FIFO and
// the one it opens, what it closed of each, and its regulatory fee accruals. Call it inside a transaction; it takes the account lock.
// The last guard against a bad fill: the price and quantity must be positive and the total not negative.
export const recordFill = async (db: PoolClient, accountId: string, fill: FillRequest): Promise<SimActivityRow> => {
    if (!(fill.price > 0) || !(fill.qty > 0) || !(fill.total >= 0)) {
        throw new Error(`Refusing an invalid ${fill.side} ${fill.symbol} fill: ${fill.qty} @ ${fill.price}, total ${fill.total}`);
    }
    await lockAccount(db, accountId);
    const at = fill.at ?? new Date();
    const symbol = fill.symbol.toUpperCase();
    await applyCorporateActions(db, accountId, [symbol], at);
    const lots = await openLots(db, accountId, symbol);
    const newLotId = randomUUID();
    const multiplier = contractMultiplier(symbol);
    const lotPrice = fill.lotPrice ?? fill.price;
    const { closings, opened, realized } = applyFill(lots, { side: fill.side, qty: fill.qty, price: lotPrice, at: at.toISOString() }, newLotId, symbol, multiplier);
    const day = dayOf(at);
    const verb = fill.side === "buy" ? "Bought" : "Sold";
    const what = multiplier > 1 ? `${parseFloat(fill.qty.toFixed(9))} ${contractName(symbol)}` : `${parseFloat(fill.qty.toFixed(9))} ${symbol}`;
    const why = fill.reason === "LIQUIDATION" ? " (margin call liquidation)" : fill.reason === "EXERCISE" ? " (option exercise)" : fill.reason === "ASSIGNMENT" ? " (option assignment)" : "";
    const description = `${verb} ${what} at $${fill.price}${why}`;
    const { rows: [row] } = await db.query<SimActivityRow>(
        `INSERT INTO sim_activities (id, account_id, activity_type, "date", created_at, net_amount, description, symbol, qty, side, price, leaves_qty, cum_qty,
                                     realized_pl, settle_date, reason, quote_time, fill_policy, legacy_order_id, order_id)
         VALUES ($1, $2, 'FILL', $3, $4, $5, $6, $7, $8, $9, $10, $17, $18, $11, $12, $13, $14, $15, $16, $19)
         RETURNING *, "date"::text AS "date", settle_date::text AS settle_date`,
        [activityId(at), accountId, day, at, (fill.side === "sell" ? fill.total : -fill.total).toFixed(2), description, symbol, fill.qty, fill.side, fill.price,
            closings.length > 0 ? roundCents(realized).toFixed(2) : null, settlementDate(day), fill.reason ?? null, fill.quoteTime ?? null, fill.fillPolicy ?? null,
            fill.legacyOrderId ?? null, fill.leavesQty ?? 0, fill.cumQty ?? fill.qty, fill.orderId ?? null]
    );
    for (const closing of closings) {
        const lot = lots.find(({ id }) => id === closing.lotId)!;
        await db.query("UPDATE sim_lots SET qty = qty - $2 WHERE id = $1", [closing.lotId, closing.qty]);
        await db.query(
            `INSERT INTO sim_lot_closings (account_id, lot_id, fill_id, qty, lot_price, close_price, realized, closed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [accountId, closing.lotId, row.id, closing.qty, lot.price, lotPrice, roundCents(closing.realized).toFixed(2), at]
        );
    }
    if (opened) {
        await db.query(
            `INSERT INTO sim_lots (id, account_id, symbol, side, qty, original_qty, price, acquired_at, fill_id) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
            [opened.id, accountId, symbol, opened.side, opened.qty, opened.price, at, row.id]
        );
    }
    // Backup withholding on the gross proceeds of the shares it closed (a long's sale price, a short's original sale price)
    if (closings.length > 0) {
        const proceeds = closings.reduce((sum, closing) => sum + closing.qty * multiplier * (fill.side === "sell" ? lotPrice : lots.find(({ id }) => id === closing.lotId)!.price), 0);
        await withhold(db, accountId, { amount: roundCents(proceeds), on: "proceeds", symbol, at });
    }
    // Shares an exercise or assignment delivers aren't an exchange trade, so they pay no transaction fees
    const fees = fill.reason === "EXERCISE" || fill.reason === "ASSIGNMENT" ? [] : feesFor({ side: fill.side, qty: fill.qty, price: fill.price, date: day, multiplier });
    for (const { type, amount } of fees) {
        await db.query(`INSERT INTO sim_fee_accruals (account_id, "date", fee_type, amount, fill_id) VALUES ($1, $2, $3, $4, $5)`, [accountId, day, type, amount, row.id]);
    }
    if (!fill.orderId) {
        await emitEvent(accountId, "trades", {
            account_id: accountId, event: "fill", execution_id: row.id, price: String(fill.price), qty: String(fill.qty), timestamp: at.toISOString(),
            position_qty: String(await positionQty(db, accountId, symbol)),
            order: { symbol, side: fill.side, qty: String(fill.qty), filled_qty: String(fill.qty), filled_avg_price: String(fill.price), status: "filled" }
        }, at, db);
    }
    return row;
};

// The account's ledger now: positions from the open lots, cash (every activity's net amount), realized P&L, net dividends, sale
// proceeds and purchase costs that haven't settled, regulatory fees accrued but not yet deducted, and from the transfers what queued
// withdrawals hold and the instant deposit credit not yet settled
export const ledgerState = async (db: Db, accountId: string, now = new Date()) => {
    const today = dayOf(now);
    const [lots, { rows: [sums] }, { rows: accruals }, transfers] = await Promise.all([
        openLots(db, accountId),
        db.query<{ realized: string; dividends: string; unsettled: string; unsettled_purchases: string }>(
            `SELECT COALESCE(SUM(realized_pl), 0) AS realized,
                    COALESCE(SUM(CASE WHEN activity_type = 'DIV' THEN net_amount ELSE 0 END), 0) AS dividends,
                    COALESCE(SUM(CASE WHEN activity_type = 'FILL' AND net_amount > 0 AND settle_date > $2 THEN net_amount ELSE 0 END), 0) AS unsettled,
                    COALESCE(SUM(CASE WHEN activity_type = 'FILL' AND net_amount < 0 AND settle_date > $2 THEN -net_amount ELSE 0 END), 0) AS unsettled_purchases
             FROM sim_activities WHERE account_id = $1`,
            [accountId, today]
        ),
        db.query<{ fee_type: FeeAccrual["type"]; amount: string }>(
            `SELECT fee_type, SUM(amount) AS amount FROM sim_fee_accruals WHERE account_id = $1 AND deducted_by IS NULL
             GROUP BY "date", fee_type`, [accountId]
        ),
        ledgerCash([accountId])
    ]);
    // What the end of day will deduct: each day's total per fee type, rounded up to the cent
    const accruedFees = { REG: 0, TAF: 0, CAT: 0, ORF: 0, OCC: 0 };
    for (const { fee_type, amount } of accruals) accruedFees[fee_type] = Math.round((accruedFees[fee_type] + roundFeeUp(Number(amount))) * 100) / 100;
    return {
        positions: positionsFromLots(lots),
        cash: transfers.cash,
        realizedPnl: Number(sums.realized),
        netDividends: Number(sums.dividends),
        unsettledProceeds: Number(sums.unsettled),
        unsettledPurchases: Number(sums.unsettled_purchases),
        accruedFees,
        pendingTransferOut: transfers.pendingOut,
        unsettledInstant: transfers.unsettledInstant
    };
};

const quotesFor = async (positions: Position[]): Promise<Record<string, Quote>> => {
    const symbols = positions.map(({ ticker }) => ticker);
    const results = await Promise.allSettled(fetchQuotes(symbols));
    return Object.fromEntries(symbols.flatMap((symbol, i) => results[i].status === "fulfilled" ? [[symbol, (results[i] as PromiseFulfilledResult<Quote>).value]] : []));
};

const accountRow = async (accountId: string): Promise<SimAccountRow> => {
    const { rows: [row] } = await pool.query<SimAccountRow>("SELECT * FROM sim_accounts WHERE id = $1", [accountId]);
    if (!row) throw new BrokerError(404, 40410000, `account not found for ${accountId}`);
    return row;
};

// GET /v1/trading/accounts/{id}/positions: the open positions at current quotes (valued at cost without one), by symbol
export const listPositions = async (accountId: string): Promise<AlpacaPosition[]> => {
    await accountRow(accountId);
    const { positions } = await ledgerState(pool, accountId);
    const quotes = await quotesFor(positions);
    const result: AlpacaPosition[] = [];
    for (const position of [...positions].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
        const asset = await findAsset(position.ticker);
        result.push(toAlpacaPosition(position, { id: asset?.alpacaId ?? assetId(position.ticker), exchange: asset?.exchange ?? "NYSE", marginable: asset?.marginable ?? true }, {
            price: quotes[position.ticker]?.price ?? null, previousClose: quotes[position.ticker]?.previousClose ?? null
        }));
    }
    return result;
};

export const getPosition = async (accountId: string, symbol: string): Promise<AlpacaPosition> => {
    const position = (await listPositions(accountId)).find(({ symbol: held }) => held === symbol.toUpperCase());
    if (!position) throw new BrokerError(404, 40410000, `position does not exist for ${symbol.toUpperCase()}`);
    return position;
};

// The account's tax lots: open ones (with their holding period today) and, with closed, the closings too
export const listLots = async (accountId: string, symbol?: string) => {
    const now = new Date().toISOString();
    const { rows } = await pool.query<LotRow>(
        "SELECT * FROM sim_lots WHERE account_id = $1 AND qty > 0 AND ($2::text IS NULL OR symbol = $2) ORDER BY symbol, acquired_at", [accountId, symbol ?? null]
    );
    return rows.map(row => ({
        id: row.id, symbol: row.symbol, side: row.side, qty: Number(row.qty), originalQty: Number(row.original_qty), price: Number(row.price),
        costBasis: roundCents(Number(row.qty) * Number(row.price) * contractMultiplier(row.symbol)), acquiredAt: row.acquired_at.toISOString(), longTerm: isLongTerm(row.acquired_at.toISOString(), now)
    }));
};

// Fills with their FIFO realized P&L, newest first, as Alpaca's trade activities plus the simulator's extra fields
export const listFills = async (db: Db, accountId: string, { since, orderIds }: { since?: Date; orderIds?: string[] } = {}) =>
    (await db.query<SimActivityRow>(
        `SELECT *, "date"::text AS "date", settle_date::text AS settle_date FROM sim_activities
         WHERE account_id = $1 AND activity_type = 'FILL' AND ($2::timestamptz IS NULL OR created_at > $2) AND ($3::uuid[] IS NULL OR order_id = ANY($3))
         ORDER BY created_at DESC, id DESC`,
        [accountId, since ?? null, orderIds ?? null]
    )).rows;

// The end of the trading day (the eod job): deducts each account's accrued regulatory fees, per day and type, rounded up to the cent
// (FEE activities with sub-types REG, TAF and CAT); ./calls.ts then keeps the closing balances and runs the margin checks
export const endOfDay = async (now = new Date()): Promise<{ fees: number }> => {
    const today = dayOf(now);
    const { rows: due } = await pool.query<{ account_id: string; date: string; fee_type: FeeAccrual["type"]; amount: string }>(
        `SELECT account_id, "date"::text, fee_type, SUM(amount) AS amount FROM sim_fee_accruals WHERE deducted_by IS NULL AND "date" <= $1
         GROUP BY account_id, "date", fee_type ORDER BY account_id, "date"`, [today]
    );
    let fees = 0;
    for (const { account_id, date, fee_type, amount } of due) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const fee = roundFeeUp(Number(amount));
            const at = new Date(Math.min(easternTime(date, "20:00").getTime(), now.getTime()));
            const activity = fee > 0
                ? await postActivity(client, { accountId: account_id, type: "FEE", subType: fee_type, netAmount: -fee, description: `${FEE_DESCRIPTIONS[fee_type]} for ${date}`, at })
                : null;
            await client.query(
                `UPDATE sim_fee_accruals SET deducted_by = $4 WHERE account_id = $1 AND "date" = $2 AND fee_type = $3 AND deducted_by IS NULL`,
                [account_id, date, fee_type, activity?.id ?? null]
            );
            await client.query("COMMIT");
            fees++;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
    return { fees };
};

// GET /v1/trading/accounts/{id}/account/portfolio/history, daily only (timeframe 1D), from the end-of-day balances: equity, its
// profit or loss from the first day shown less the deposits and withdrawals since, and the base (the first day's equity). The app's
// performance chart rebuilds the history from the ledger instead (it also covers days before the snapshots began).
export const getPortfolioHistory = async (accountId: string, query: { start?: string; end?: string } = {}) => {
    await accountRow(accountId);
    const { rows } = await pool.query<{ date: string; equity: string }>(
        `SELECT "date"::text, equity FROM sim_daily_balances WHERE account_id = $1 AND ($2::date IS NULL OR "date" >= $2) AND ($3::date IS NULL OR "date" <= $3) ORDER BY "date"`,
        [accountId, query.start?.slice(0, 10) ?? null, query.end?.slice(0, 10) ?? null]
    );
    const { rows: flows } = await pool.query<{ date: string; amount: string }>(
        `SELECT "date"::text, SUM(net_amount) AS amount FROM sim_activities WHERE account_id = $1 AND activity_type IN ('CSD', 'CSW') GROUP BY "date"`, [accountId]
    );
    const base = rows.length > 0 ? Number(rows[0].equity) : 0;
    let deposits = 0;
    const profit = rows.map(({ date, equity }, i) => {
        if (i > 0) deposits += flows.filter(flow => flow.date > rows[i - 1].date && flow.date <= date).reduce((sum, flow) => sum + Number(flow.amount), 0);
        return roundCents(Number(equity) - base - deposits);
    });
    return {
        timestamp: rows.map(({ date }) => Math.floor(easternTime(date, "16:00").getTime() / 1000)),
        equity: rows.map(({ equity }) => Number(equity)),
        profit_loss: profit,
        profit_loss_pct: profit.map(pnl => base > 0 ? pnl / base : 0),
        base_value: base,
        timeframe: "1D" as const
    };
};
