import "server-only";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { fetchQuote, isStaleQuote } from "../../marketData";
import { roundCents } from "../../account";
import { easternParts, nextTradingDay, sessionOn } from "../../../marketHours";
import { contractName, intrinsicValue, parseOptionSymbol } from "../../../options";
import { lockAccount, openLots, recordFill } from "./positions";
import { postActivity } from "./transfers";
import { marginSnapshot } from "./marginAccount";
import { createOrder } from "./orders";
import { deliveryFor, earlyAssignmentLikely, expirationOutcome, OPTION_MULTIPLIER, sharesCoveringCalls } from "./options";
import type { Lot } from "./ledger";

// Option exercise, assignment and expiration in the simulator, as Alpaca handles them: a manual exercise (POST .../positions/{symbol}/
// exercise) is processed at once, but not between the close and midnight; a do-not-exercise instruction keeps a long contract from
// being exercised at expiration. On expiration day, in-the-money long contracts the account couldn't exercise (a call without the
// buying power for the shares, a put without the shares) are sold in the last hour (the expiring-options job, 3:00 p.m. ET); after the
// close (the options-expiration job), contracts in the money by $0.01 or more are exercised (longs) or assigned (shorts) and the rest
// expire worthless. Short calls in the money with less time value than the next day's dividend are assigned early, the evening before
// the ex-date. An exercise or assignment posts its activity (OPEXC, OPASN) closing the contracts without P&L, and a FILL of the shares
// at the strike, the premium rolled into the price the share lots use (and so into the gain reported when they're sold); an expiry posts
// OPEXP, closing the contracts at nothing (a long's premium lost, a short's kept).

const LABEL = "Sim options";
const forbidden = (message: string) => new BrokerError(403, 40310000, message);

type Db = PoolClient;

const withAccount = async <T>(accountId: string, fn: (db: Db) => Promise<T>): Promise<T> => {
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

// Takes contracts from the lots, oldest first: what each gives up and the average premium of those taken
const takeFromLots = (lots: Lot[], contracts: number) => {
    let left = contracts;
    const parts: { lot: Lot; qty: number }[] = [];
    for (const lot of lots) {
        if (left <= 1e-9) break;
        const qty = Math.min(lot.qty, left);
        parts.push({ lot, qty });
        left -= qty;
    }
    const taken = parts.reduce((sum, { qty }) => sum + qty, 0);
    return { parts, taken, premium: taken > 0 ? parts.reduce((sum, { lot, qty }) => sum + lot.price * qty, 0) / taken : 0 };
};

// Exercises (a long) or assigns (a short) contracts of the position: the activity, the contracts closed without P&L, and the shares
// traded at the strike with the premium in their lots' price
const deliver = async (db: Db, accountId: string, symbol: string, contracts: number, kind: "exercise" | "assignment", at = new Date()) => {
    const contract = parseOptionSymbol(symbol)!;
    const lots = await openLots(db, accountId, symbol);
    if (lots.length === 0) return null;
    const long = lots[0].side === "long";
    const { parts, taken, premium } = takeFromLots(lots, contracts);
    if (!(taken > 0)) return null;
    const activity = await postActivity(db, {
        // qty signed as corporate actions' are: contracts removed from a long negative, from a short positive
        accountId, type: kind === "exercise" ? "OPEXC" : "OPASN", netAmount: 0, symbol, qty: long ? -taken : taken, at,
        description: `${contractName(symbol)}: ${taken} contract${taken === 1 ? "" : "s"} ${kind === "exercise" ? "exercised" : "assigned"}`
    });
    for (const { lot, qty } of parts) {
        await db.query("UPDATE sim_lots SET qty = qty - $2 WHERE id = $1", [lot.id, qty]);
        await db.query(
            `INSERT INTO sim_lot_closings (account_id, lot_id, fill_id, qty, lot_price, close_price, realized, closed_at) VALUES ($1, $2, $3, $4, $5, $5, 0, $6)`,
            [accountId, lot.id, activity.id, qty, lot.price, at]
        );
    }
    const delivery = deliveryFor({ type: contract.type, strike: contract.strike, qty: long ? taken : -taken, premium });
    await recordFill(db, accountId, {
        symbol: contract.underlying, side: delivery.side, qty: delivery.shares, price: delivery.cashPrice, total: roundCents(delivery.shares * delivery.cashPrice),
        lotPrice: delivery.lotPrice, reason: kind === "exercise" ? "EXERCISE" : "ASSIGNMENT", at
    });
    return { activity, taken };
};

// Expires the position's contracts worthless: closed at nothing, a long's premium lost and a short's kept
const expire = async (db: Db, accountId: string, symbol: string, at = new Date()) => {
    const lots = await openLots(db, accountId, symbol);
    if (lots.length === 0) return null;
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const activity = await postActivity(db, { accountId, type: "OPEXP", netAmount: 0, symbol, qty: lots[0].side === "long" ? -qty : qty, at, description: `${contractName(symbol)} expired worthless` });
    let realized = 0;
    for (const lot of lots) {
        const pnl = roundCents((lot.side === "long" ? -1 : 1) * lot.price * lot.qty * OPTION_MULTIPLIER);
        realized += pnl;
        await db.query("UPDATE sim_lots SET qty = 0 WHERE id = $1", [lot.id]);
        await db.query(
            `INSERT INTO sim_lot_closings (account_id, lot_id, fill_id, qty, lot_price, close_price, realized, closed_at) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
            [accountId, lot.id, activity.id, lot.qty, lot.price, pnl.toFixed(2), at]
        );
    }
    await db.query("UPDATE sim_activities SET realized_pl = $2 WHERE id = $1", [activity.id, roundCents(realized).toFixed(2)]);
    return activity;
};

const longShares = async (db: Db, accountId: string, symbol: string) =>
    (await openLots(db, accountId, symbol)).filter(({ side }) => side === "long").reduce((sum, lot) => sum + lot.qty, 0);

// The account's option holdings in an underlying, signed
const holdingsIn = async (db: Db, accountId: string, underlying: string) => {
    const { rows } = await db.query<{ symbol: string; side: "long" | "short"; qty: string }>(
        "SELECT symbol, side, SUM(qty) AS qty FROM sim_lots WHERE account_id = $1 AND qty > 0 AND symbol LIKE $2 GROUP BY symbol, side", [accountId, `${underlying}%`]
    );
    return rows.flatMap(({ symbol, side, qty }) => {
        const contract = parseOptionSymbol(symbol);
        return contract && contract.underlying === underlying ? [{ ...contract, symbol, qty: side === "long" ? Number(qty) : -Number(qty) }] : [];
    });
};

// POST /v1/trading/accounts/{id}/positions/{symbol_or_contract_id}/exercise: exercises qty (default all) of a long contract now. Not
// between the close and midnight; a call needs the buying power for its shares, a put the shares (those not covering short calls).
export const exerciseOption = async (accountId: string, symbol: string, { qty }: { qty?: string | number } = {}, now = new Date()) => {
    const contract = parseOptionSymbol(symbol);
    if (!contract) throw new BrokerError(404, 40410000, `position does not exist for ${symbol}`);
    const session = sessionOn(easternParts(now).dateKey);
    if (session && now >= session.close) throw forbidden("exercise requests between the market close and midnight are rejected");
    if (contract.expiration < easternParts(now).dateKey) throw forbidden(`${symbol} has expired`);
    return withAccount(accountId, async db => {
        const lots = await openLots(db, accountId, symbol.toUpperCase());
        const held = lots.filter(({ side }) => side === "long").reduce((sum, lot) => sum + lot.qty, 0);
        if (!(held > 0)) throw forbidden(`no available position for ${symbol}: only long contracts can be exercised`);
        const contracts = qty === undefined || qty === "" ? held : Number(qty);
        if (!Number.isInteger(contracts) || contracts < 1 || contracts > held) throw new BrokerError(422, 40010001, `qty must be a whole number of contracts from 1 to ${held}`);
        const shares = contracts * OPTION_MULTIPLIER;
        if (contract.type === "call") {
            const snapshot = await marginSnapshot(db, accountId);
            const cost = shares * contract.strike;
            if (cost > snapshot.state.buyingPower + 0.005) {
                throw forbidden(`insufficient buying power to exercise: the shares cost $${cost.toFixed(2)}, $${snapshot.state.buyingPower.toFixed(2)} is available`);
            }
        } else {
            const free = await longShares(db, accountId, contract.underlying) - sharesCoveringCalls(await holdingsIn(db, accountId, contract.underlying));
            if (free + 1e-9 < shares) throw forbidden(`exercising ${contracts} put${contracts === 1 ? "" : "s"} delivers ${shares} shares of ${contract.underlying}; ${Math.max(0, free)} are available`);
        }
        await deliver(db, accountId, symbol.toUpperCase(), contracts, "exercise", now);
        return { qty_exercised: String(contracts), qty_remaining: String(held - contracts) };
    });
};

// POST .../positions/{symbol_or_contract_id}/do-not-exercise: the long contract isn't exercised at expiration, even in the money
export const doNotExercise = async (accountId: string, symbol: string) => {
    const lots = await openLots(pool, accountId, symbol.toUpperCase());
    if (!lots.some(({ side }) => side === "long")) throw forbidden(`no available position for ${symbol}: only long contracts can be left unexercised`);
    await pool.query(
        `INSERT INTO sim_option_instructions (account_id, symbol, instruction) VALUES ($1, $2, 'do_not_exercise') ON CONFLICT (account_id, symbol) DO NOTHING`,
        [accountId, symbol.toUpperCase()]
    );
};

// Open option positions expiring on or before day, per account
const expiringPositions = async (day: string) => {
    const { rows } = await pool.query<{ account_id: string; symbol: string; side: "long" | "short"; qty: string }>(
        `SELECT account_id, symbol, side, SUM(qty) AS qty FROM sim_lots WHERE qty > 0 AND symbol ~ '^[A-Z]{1,6}[0-9]{6}[CP][0-9]{8}$' GROUP BY account_id, symbol, side`
    );
    return rows.flatMap(row => {
        const contract = parseOptionSymbol(row.symbol)!;
        return contract.expiration <= day ? [{ accountId: row.account_id, symbol: row.symbol, contract, qty: row.side === "long" ? Number(row.qty) : -Number(row.qty) }] : [];
    });
};

// The underlying's current price, or null when it can't be had (the run is retried on the next check)
const underlyingPrice = async (symbol: string, now: Date) => {
    const quote = await fetchQuote(symbol).catch(() => null);
    return quote && !isStaleQuote(quote, now) ? quote.price : null;
};

// The expiring-options job (3:00 p.m. ET on trading days): in-the-money long contracts expiring today that the account couldn't
// exercise are sold, as Alpaca sells them out in the hour before expiry: a call without the buying power for its shares, a put without
// the shares. Placed as day market orders (client_order_id expiry-<contract>-<day>, so once each).
export const closeUnexercisable = async (now = new Date()) => {
    const day = easternParts(now).dateKey;
    const session = sessionOn(day);
    if (!session || now >= session.close) return { sold: 0 };
    let sold = 0;
    for (const position of (await expiringPositions(day)).filter(({ qty, contract }) => qty > 0 && contract.expiration === day)) {
        const price = await underlyingPrice(position.contract.underlying, now);
        if (price === null || intrinsicValue(position.contract.type, position.contract.strike, price) < 0.01) continue;
        const shares = position.qty * OPTION_MULTIPLIER;
        const client = await pool.connect();
        let exercisable: boolean;
        try {
            if (position.contract.type === "call") exercisable = (await marginSnapshot(client, position.accountId)).state.buyingPower >= shares * position.contract.strike;
            else exercisable = await longShares(client, position.accountId, position.contract.underlying) - sharesCoveringCalls(await holdingsIn(client, position.accountId, position.contract.underlying)) >= shares;
        } finally {
            client.release();
        }
        if (exercisable) continue;
        await createOrder(position.accountId, {
            symbol: position.symbol, side: "sell", type: "market", time_in_force: "day", qty: String(position.qty), position_intent: "sell_to_close",
            client_order_id: `expiry-${position.symbol}-${day}`
        }, { liquidation: true }).then(() => sold++, error => {
            if (!/client_order_id must be unique/.test(error.message)) console.error(`${LABEL}: selling ${position.symbol} before expiry: ${error.message}`);
        });
    }
    return { sold };
};

// The options-expiration job (4:45 p.m. ET, after Alpaca's 4:30 p.m. do-not-exercise deadline; any later check catches up): every
// option position that has expired, at its underlying's close, exercised, assigned or expired (shares bought before shares sold within
// an account, so a spread's legs settle against each other); then short calls likely assigned early before tomorrow's ex-dates
export const processExpirations = async (now = new Date()) => {
    const day = easternParts(now).dateKey;
    const session = sessionOn(day);
    const cutoff = session ? session.close : null;
    const positions = (await expiringPositions(day)).filter(({ contract }) => contract.expiration < day || (cutoff !== null && now >= new Date(cutoff.getTime() + 30 * 60000)) || (cutoff === null && contract.expiration <= day));
    const counts = { exercised: 0, assigned: 0, expired: 0, early: 0 };
    const prices = new Map<string, number | null>();
    const priceOf = async (symbol: string) => {
        if (!prices.has(symbol)) prices.set(symbol, await underlyingPrice(symbol, now));
        return prices.get(symbol)!;
    };
    let unpriced = 0;
    for (const accountId of new Set(positions.map(({ accountId }) => accountId))) {
        const mine = positions.filter(position => position.accountId === accountId);
        const plans: { symbol: string; outcome: ReturnType<typeof expirationOutcome>; buys: boolean; qty: number }[] = [];
        const { rows: instructions } = await pool.query<{ symbol: string }>("SELECT symbol FROM sim_option_instructions WHERE account_id = $1", [accountId]);
        for (const position of mine) {
            const price = await priceOf(position.contract.underlying);
            if (price === null) {
                unpriced++;
                continue;
            }
            let outcome = expirationOutcome({ ...position.contract, qty: position.qty }, price, { doNotExercise: instructions.some(({ symbol }) => symbol === position.symbol) });
            // A long put is only exercised with the shares to deliver (Alpaca places a do-not-exercise otherwise)
            if (outcome === "exercise" && position.contract.type === "put") {
                const client = await pool.connect();
                try {
                    const free = await longShares(client, accountId, position.contract.underlying) - sharesCoveringCalls(await holdingsIn(client, accountId, position.contract.underlying));
                    if (free + 1e-9 < position.qty * OPTION_MULTIPLIER) outcome = "expire";
                } finally {
                    client.release();
                }
            }
            plans.push({ symbol: position.symbol, outcome, qty: Math.abs(position.qty), buys: (position.contract.type === "call") === (position.qty > 0) });
        }
        plans.sort((a, b) => Number(b.buys && b.outcome !== "expire") - Number(a.buys && a.outcome !== "expire"));
        await withAccount(accountId, async db => {
            for (const plan of plans) {
                if (plan.outcome === "expire") {
                    if (await expire(db, accountId, plan.symbol, now)) counts.expired++;
                } else if (await deliver(db, accountId, plan.symbol, plan.qty, plan.outcome === "exercise" ? "exercise" : "assignment", now)) {
                    counts[plan.outcome === "exercise" ? "exercised" : "assigned"]++;
                }
            }
            await db.query("DELETE FROM sim_option_instructions WHERE account_id = $1 AND symbol = ANY($2)", [accountId, plans.map(({ symbol }) => symbol)]);
        }).catch(error => console.error(`${LABEL}: expiring ${accountId}'s options: ${error.message}`));
    }
    counts.early = await assignEarly(now);
    if (unpriced > 0) throw new Error(`${unpriced} expired option position${unpriced === 1 ? "" : "s"} couldn't be priced; retrying`);
    return counts;
};

// Short calls likely assigned early: on a trading day after the close, those in the money with less time value than the dividend whose
// ex-date is the next trading day (earlyAssignmentLikely), assigned in full
export const assignEarly = async (now = new Date()) => {
    const day = easternParts(now).dateKey;
    const session = sessionOn(day);
    if (!session || now < session.close) return 0;
    const exDate = nextTradingDay(day);
    const { rows: dividends } = await pool.query<{ ticker: string; amount: string }>(
        `SELECT ticker, amount FROM corporate_actions WHERE "type" = 'DIVIDEND' AND ex_date = $1 AND amount > 0`, [exDate]
    );
    if (dividends.length === 0) return 0;
    const { rows } = await pool.query<{ account_id: string; symbol: string; qty: string }>(
        `SELECT account_id, symbol, SUM(qty) AS qty FROM sim_lots WHERE qty > 0 AND side = 'short' AND symbol ~ $1 GROUP BY account_id, symbol`,
        [`^(${dividends.map(({ ticker }) => ticker.replace(/[^A-Z]/g, "")).join("|")})[0-9]{6}C[0-9]{8}$`]
    );
    let assigned = 0;
    for (const row of rows) {
        const contract = parseOptionSymbol(row.symbol)!;
        if (contract.expiration <= day) continue;
        const dividend = Number(dividends.find(({ ticker }) => ticker === contract.underlying)?.amount ?? 0);
        const [price, option] = await Promise.all([underlyingPrice(contract.underlying, now), fetchQuote(row.symbol).catch(() => null)]);
        if (price === null || !option) continue;
        if (!earlyAssignmentLikely({ type: "call", strike: contract.strike, underlying: price, optionPrice: option.price, dividend })) continue;
        const done = await withAccount(row.account_id, db => deliver(db, row.account_id, row.symbol, Number(row.qty), "assignment", now))
            .catch(error => {
                console.error(`${LABEL}: early assignment of ${row.symbol}: ${error.message}`);
                return null;
            });
        if (done) assigned++;
    }
    return assigned;
};
