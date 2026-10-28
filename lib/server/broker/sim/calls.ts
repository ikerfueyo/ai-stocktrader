import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { addDays, easternParts, easternTime, isTradingDay, marketStatus, nextTradingDay } from "../../../marketHours";
import { getMarketStatus } from "../../market";
import { roundCents } from "../../account";
import { emitEvent } from "./accounts";
import { lockAccount } from "./positions";
import { postActivity } from "./transfers";
import { borrowFee, deficiencies, marginInterest, needsImmediateLiquidation, planLiquidation, type CallType } from "./margin";
import { hardToBorrow, marginSnapshot, type MarginSnapshot } from "./marginAccount";
import { cancelAllOrders, createOrder } from "./orders";

// Margin calls, liquidation, margin interest and hard-to-borrow fees in the simulator, as Alpaca runs them:
//   At each close (the eod job), an account below its maintenance requirement, or below Reg T initial margin after a day that opened
//   positions, gets a call for the difference, issued the next morning and due SIM_MARGIN_CALL_DAYS trading days later (default 2,
//   by 3:45 p.m. ET). While a call is open, only closing orders and deposits are allowed, and withdrawals wait.
//   A call is met once the deficiency is gone (deposits, closing trades or prices) or deposits since it was issued cover it. An unmet
//   call at its deadline is met by liquidation (cancel the open orders, then close the riskiest positions, just enough). Equity far
//   below the maintenance requirement (below SIM_LIQUIDATION_RATIO of it, default 0.75) or gone is liquidated at once, during the
//   regular session.
//   Margin interest accrues each night on the settlement-date debit balance (SIM_MARGIN_RATE, default 6.50% a year, / 360, for each
//   calendar day until the next trading day) and posts at month end (INT, MGN). A hard-to-borrow short pays a daily borrow fee
//   (SIM_HTB_BORROW_RATE, default 30% a year, simulated) on the nearest round lot.

const LABEL = "Sim margin";
const CALL_DAYS = Math.max(1, Number(process.env.SIM_MARGIN_CALL_DAYS ?? 2));
const LIQUIDATION_RATIO = Number(process.env.SIM_LIQUIDATION_RATIO ?? 0.75);
export const MARGIN_RATE = Number(process.env.SIM_MARGIN_RATE ?? 0.065);
export const HTB_BORROW_RATE = Number(process.env.SIM_HTB_BORROW_RATE ?? 0.3);

const dayOf = (date: Date) => easternParts(date).dateKey;
const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The calendar days a balance at dateKey's close carries until the next trading day (3 over a weekend)
const carryDays = (dateKey: string) => Math.round((Date.parse(`${nextTradingDay(dateKey)}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86400000);

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

// Whether the account opened or added to a position on dateKey (a lot acquired that day)
const openedOn = async (accountId: string, dateKey: string) =>
    (await pool.query("SELECT 1 FROM sim_lots WHERE account_id = $1 AND acquired_at >= $2 AND acquired_at < $3 LIMIT 1",
        [accountId, easternTime(dateKey, "00:00"), easternTime(addDays(dateKey, 1), "00:00")])).rowCount! > 0;

const callEvent = (db: PoolClient, accountId: string, event: string, call: { id: string; type: string; amount: number | string; due_at?: Date }) =>
    emitEvent(accountId, "accounts", { account_id: accountId, event, margin_call: { id: call.id, type: call.type, amount: String(call.amount), due_at: call.due_at?.toISOString() } }, new Date(), db);

// Closes positions to cover a deficiency (planLiquidation) with the simulator's own day market orders, after cancelling the account's
// open orders, as Alpaca does before it liquidates. Returns the orders placed.
const liquidate = async (snapshot: MarginSnapshot, deficiency: number, type: CallType, why: string) => {
    const accountId = snapshot.row.id;
    const trades = planLiquidation(snapshot.positions, deficiency, { type, equity: snapshot.state.equity });
    if (trades.length === 0) return [];
    await cancelAllOrders(accountId);
    const placed = [];
    for (const trade of trades) {
        placed.push(await createOrder(accountId, {
            symbol: trade.symbol, side: trade.side, type: "market", time_in_force: "day", qty: String(trade.qty),
            position_intent: trade.side === "sell" ? "sell_to_close" : "buy_to_close", client_order_id: `liquidation-${randomUUID()}`
        }, { liquidation: true }));
    }
    console.log(`${LABEL}: liquidated for ${accountId} (${why}): ${trades.map(({ side, qty, symbol }) => `${side} ${qty} ${symbol}`).join(", ")}`);
    return placed;
};

// The margin upkeep for one account (from the account routes and the accounts job): meet its calls whose deficiency is gone or
// whose deposits cover them, then, during the regular session and on current prices only, liquidate for a call past its deadline or
// for equity far below the requirement. Returns the liquidation orders placed.
export const enforceMargin = async (accountId: string, now = new Date()) => {
    const snapshot = await marginSnapshot(pool, accountId, { now });
    const { state, calls } = snapshot;
    for (const call of calls) {
        const deficiency = deficiencies(state, { openedToday: true })[call.type];
        const { rows: [{ deposited }] } = await pool.query<{ deposited: string }>(
            "SELECT COALESCE(SUM(net_amount), 0) AS deposited FROM sim_activities WHERE account_id = $1 AND activity_type = 'CSD' AND created_at >= $2", [accountId, call.issued_at]
        );
        if (deficiency <= 0 || Number(deposited) >= Number(call.amount) - 0.005) {
            await withAccountTx(accountId, async db => {
                await db.query("UPDATE sim_margin_calls SET status = 'met', resolved_at = now() WHERE id = $1 AND status = 'open'", [call.id]);
                await callEvent(db, accountId, "margin_call_met", call);
            });
        }
    }
    const market = await getMarketStatus();
    if (market.session !== "regular" || snapshot.staleTickers.length > 0) return [];
    // An earlier liquidation still working (no fill yet) is left to finish
    const { rowCount: working } = await pool.query("SELECT 1 FROM sim_orders WHERE account_id = $1 AND liquidation AND status IN ('new', 'accepted', 'partially_filled') LIMIT 1", [accountId]);
    if (working) return [];
    const open = await pool.query<{ id: string; type: CallType; amount: string; due_at: Date }>(
        "SELECT id, \"type\", amount, due_at FROM sim_margin_calls WHERE account_id = $1 AND status = 'open' AND issued_at <= $2 ORDER BY due_at", [accountId, now]
    );
    const due = open.rows.filter(({ due_at }) => due_at <= now);
    const current = deficiencies(state, { openedToday: true });
    if (due.length > 0) {
        const type = due.some(({ type }) => type === "maintenance") ? "maintenance" : "regt";
        const deficiency = Math.max(current[type], ...due.filter(call => call.type === type).map(({ amount }) => Number(amount)));
        const placed = await liquidate(snapshot, deficiency, type, `${type} call of ${money(deficiency)} past its deadline`);
        await withAccountTx(accountId, async db => {
            for (const call of due) {
                await db.query("UPDATE sim_margin_calls SET status = 'liquidated', resolved_at = now() WHERE id = $1", [call.id]);
                await callEvent(db, accountId, "margin_call_liquidated", call);
            }
        });
        return placed;
    }
    if (needsImmediateLiquidation(state, LIQUIDATION_RATIO)) {
        return liquidate(snapshot, current.maintenance, "maintenance", `equity ${money(state.equity)} against a ${money(state.maintenanceMargin)} requirement`);
    }
    return [];
};

// The accounts the margin upkeep watches: those borrowing, short or with an open call
export const accountsOnMargin = async (): Promise<string[]> =>
    (await pool.query<{ id: string }>(
        `SELECT DISTINCT account_id AS id FROM sim_lots WHERE side = 'short' AND qty > 0
         UNION SELECT account_id FROM sim_margin_calls WHERE status = 'open'
         UNION SELECT a.account_id FROM sim_activities a GROUP BY a.account_id HAVING SUM(a.net_amount) < 0`
    )).rows.map(({ id }) => id);

// The margin end of day (the eod job, after the fee deductions), for every open account after the close on a trading day: keeps the
// closing balances (the trading account's last_* fields), issues the calls the close shows, accrues the night's margin interest on
// the settlement-date debit and charges hard-to-borrow shorts their borrow fee, then posts the month's interest after its last trading
// day. Each step is kept once per account and day, so running it again does nothing new.
export const endOfDayMargin = async (now = new Date()) => {
    const today = dayOf(now);
    if (!isTradingDay(today) || marketStatus(now).open) return { balances: 0, calls: 0, interest: 0, borrowFees: 0 };
    const { rows: accounts } = await pool.query<{ id: string }>("SELECT id FROM sim_accounts WHERE status IN ('ACTIVE', 'ACCOUNT_UPDATED')");
    const result = { balances: 0, calls: 0, interest: 0, borrowFees: 0 };
    const days = carryDays(today);
    const issueDay = nextTradingDay(today);
    let dueDay = issueDay;
    for (let i = 1; i < CALL_DAYS; i++) dueDay = nextTradingDay(dueDay);
    for (const { id } of accounts) {
        try {
            const snapshot = await marginSnapshot(pool, id, { session: "closed", now });
            const { state, ledger } = snapshot;
            await pool.query(
                `INSERT INTO sim_daily_balances (account_id, "date", equity, cash, long_market_value, short_market_value, maintenance_margin, initial_margin, buying_power, regt_buying_power)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (account_id, "date") DO UPDATE SET equity = EXCLUDED.equity, cash = EXCLUDED.cash, long_market_value = EXCLUDED.long_market_value,
                     short_market_value = EXCLUDED.short_market_value, maintenance_margin = EXCLUDED.maintenance_margin, initial_margin = EXCLUDED.initial_margin,
                     buying_power = EXCLUDED.buying_power, regt_buying_power = EXCLUDED.regt_buying_power`,
                [id, today, state.equity, ledger.cash, state.longMarketValue, state.shortMarketValue, state.maintenanceMargin, state.initialMargin, state.buyingPower, state.regtBuyingPower]
            );
            result.balances++;
            await withAccountTx(id, async db => {
                // Calls
                const owed = deficiencies(state, { openedToday: await openedOn(id, today) });
                for (const type of ["maintenance", "regt"] as CallType[]) {
                    if (owed[type] <= 0) continue;
                    const { rows: [existing] } = await db.query<{ id: string }>("SELECT id FROM sim_margin_calls WHERE account_id = $1 AND \"type\" = $2 AND status = 'open'", [id, type]);
                    if (existing) {
                        await db.query("UPDATE sim_margin_calls SET amount = $2 WHERE id = $1", [existing.id, owed[type]]);
                        continue;
                    }
                    const call = { id: randomUUID(), type, amount: owed[type], due_at: easternTime(dueDay, "15:45") };
                    await db.query(
                        `INSERT INTO sim_margin_calls (id, account_id, "type", amount, "date", issued_at, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [call.id, id, type, call.amount, today, easternTime(issueDay, "08:00"), call.due_at]
                    );
                    await callEvent(db, id, "margin_call", call);
                    result.calls++;
                }
                // Margin interest on the settlement-date debit: cash as if every trade had settled on its settlement date
                const settledCash = ledger.cash - ledger.unsettledProceeds + ledger.unsettledPurchases;
                const debit = roundCents(Math.max(0, -settledCash));
                if (debit > 0) {
                    const { rowCount } = await db.query(
                        `INSERT INTO sim_interest_accruals (account_id, "date", debit, rate, days, amount) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
                        [id, today, debit, MARGIN_RATE, days, marginInterest(debit, MARGIN_RATE, days)]
                    );
                    result.interest += rowCount ?? 0;
                }
                // Hard-to-borrow fees
                for (const position of snapshot.positions.filter(({ qty, symbol }) => qty < 0 && hardToBorrow(symbol, snapshot.assets[symbol]))) {
                    const amount = roundCents(borrowFee({ qty: position.qty, price: position.price, rate: HTB_BORROW_RATE, days }));
                    const { rowCount } = await db.query(
                        `INSERT INTO sim_borrow_fees (account_id, "date", symbol, qty, price, rate, amount) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
                        [id, today, position.symbol, Math.abs(position.qty), position.price, HTB_BORROW_RATE, amount]
                    );
                    if (!rowCount || amount < 0.01) continue;
                    const activity = await postActivity(db, {
                        accountId: id, type: "FEE", netAmount: -amount, symbol: position.symbol, qty: Math.abs(position.qty),
                        description: `Stock borrow fee: ${position.symbol} short, ${days} day${days === 1 ? "" : "s"} at ${(HTB_BORROW_RATE * 100).toFixed(2)}% a year (simulated rate)`,
                        at: new Date(Math.min(easternTime(today, "20:00").getTime(), now.getTime()))
                    });
                    await db.query(`UPDATE sim_borrow_fees SET activity_id = $4 WHERE account_id = $1 AND "date" = $2 AND symbol = $3`, [id, today, position.symbol, activity.id]);
                    result.borrowFees++;
                }
                // The month's interest posts after its last trading day
                if (issueDay.slice(0, 7) !== today.slice(0, 7)) await postInterest(db, id, today);
            });
        } catch (error) {
            console.error(`${LABEL}: end of day for ${id}: ${error instanceof Error ? error.message : error}`);
        }
    }
    return result;
};

// Posts the account's unposted margin interest through dateKey as one INT (MGN) activity, rounded to the cent
const postInterest = async (db: PoolClient, accountId: string, dateKey: string) => {
    const { rows: [{ amount }] } = await db.query<{ amount: string | null }>(
        `SELECT SUM(amount) AS amount FROM sim_interest_accruals WHERE account_id = $1 AND "date" <= $2 AND posted_by IS NULL`, [accountId, dateKey]
    );
    const interest = roundCents(Number(amount ?? 0));
    if (!(interest >= 0.01)) return;
    const month = new Date(`${dateKey}T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const activity = await postActivity(db, {
        accountId, type: "INT", subType: "MGN", netAmount: -interest, description: `Margin interest for ${month} at ${(MARGIN_RATE * 100).toFixed(2)}% a year`,
        at: easternTime(dateKey, "20:00")
    });
    await db.query(`UPDATE sim_interest_accruals SET posted_by = $3 WHERE account_id = $1 AND "date" <= $2 AND posted_by IS NULL`, [accountId, dateKey, activity.id]);
};

// The margin interest accrued and not yet posted (this month's), for the pages
export const accruedInterest = async (accountId: string): Promise<number> => {
    const { rows: [{ amount }] } = await pool.query<{ amount: string | null }>(
        "SELECT SUM(amount) AS amount FROM sim_interest_accruals WHERE account_id = $1 AND posted_by IS NULL", [accountId]
    );
    return roundCents(Number(amount ?? 0));
};
