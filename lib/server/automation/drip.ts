import "server-only";
import pool from "../db";
import { getBroker } from "../broker";
import { isHttpError } from "../httpError";
import { notify } from "../notifications";
import { backupWithholding } from "../broker/sim/tax";
import type { DripSettings } from "../../types";

// Dividend reinvestment (app-level, any broker): each cash dividend received on a position whose reinvestment is on (its own choice,
// else the account's) buys more of the stock with what was paid, less any backup withholding, as a day notional market order
// (client_order_id drip-<activity>, so a dividend is reinvested at most once). Only fractionable stocks can be reinvested; amounts
// under the $1 notional minimum are held and added to the next dividend of the same stock.
const MIN_NOTIONAL = 1;
const round = (value: number) => Math.round(value * 100) / 100;

export const dripEnabled = async (accountId: string, symbol: string): Promise<boolean> => {
    const { rows } = await pool.query<{ symbol: string; enabled: boolean }>("SELECT symbol, enabled FROM drip_settings WHERE account_id = $1 AND symbol IN ('*', $2)", [accountId, symbol]);
    return (rows.find(row => row.symbol === symbol) ?? rows.find(row => row.symbol === "*"))?.enabled ?? false;
};

type Outcome = "ordered" | "held" | "skipped" | "failed";
const record = (activityId: string, accountId: string, symbol: string, amount: number, outcome: Outcome, orderId: string | null, note: string | null) => pool.query(
    `INSERT INTO drip_reinvestments (activity_id, account_id, symbol, amount, outcome, order_id, note) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (activity_id) DO NOTHING`,
    [activityId, accountId, symbol, amount.toFixed(2), outcome, orderId, note?.slice(0, 500) ?? null]
);

// Handles a cash dividend activity (the nta stream's DIV) for the account's user
export const reinvestDividend = async (userId: string, accountId: string, activity: { id: string; date?: string; net_amount?: string; symbol?: string }) => {
    const symbol = activity.symbol?.toUpperCase();
    const gross = Number(activity.net_amount ?? 0);
    if (!symbol || !(gross > 0)) return;
    const { rowCount } = await pool.query("SELECT 1 FROM drip_reinvestments WHERE activity_id = $1", [activity.id]);
    if (rowCount || !(await dripEnabled(accountId, symbol))) return;
    const broker = getBroker();
    // What was withheld from it: backup withholding posts with the dividend, the same day, 24% of it
    const expected = backupWithholding(gross);
    const withholding = expected > 0 && activity.date ? (await broker.listActivities(accountId, { activity_types: ["WH"], date: activity.date } as never))
        .find(entry => {
            const { symbol: whSymbol, net_amount } = entry as { symbol?: string; net_amount?: string };
            return whSymbol === symbol && Math.abs(Math.abs(Number(net_amount)) - expected) < 0.005;
        }) : undefined;
    const withheld = withholding ? expected : 0;
    const net = round(gross - withheld);
    const fail = async (outcome: Outcome, note: string) => {
        await record(activity.id, accountId, symbol, net, outcome, null, note);
        await notify(userId, accountId, { kind: "recurring", title: `Dividend not reinvested: ${symbol}`, body: note, link: "/notifications?tab=drip", dedupeKey: `drip:${activity.id}` });
    };
    const asset = await broker.getAsset(symbol).catch(() => null);
    if (!asset || !asset.fractionable || !asset.tradable) return fail("skipped", `${symbol} ${asset ? "can't be bought in fractions" : "isn't tradable"}, so its $${net.toFixed(2)} dividend stays as cash.`);
    const { rows: [pending] } = await pool.query<{ amount: string }>("SELECT amount FROM drip_pending WHERE account_id = $1 AND symbol = $2", [accountId, symbol]);
    const total = round(net + Number(pending?.amount ?? 0));
    if (total < MIN_NOTIONAL) {
        await pool.query(
            `INSERT INTO drip_pending (account_id, symbol, amount) VALUES ($1, $2, $3) ON CONFLICT (account_id, symbol) DO UPDATE SET amount = EXCLUDED.amount`, [accountId, symbol, total.toFixed(2)]
        );
        return record(activity.id, accountId, symbol, net, "held", null, `Held until ${symbol}'s dividends reach $${MIN_NOTIONAL.toFixed(2)} ($${total.toFixed(2)} so far)`);
    }
    try {
        const order = await broker.createOrder(accountId, { symbol, side: "buy", type: "market", time_in_force: "day", notional: total.toFixed(2), client_order_id: `drip-${activity.id}` } as never);
        await pool.query("DELETE FROM drip_pending WHERE account_id = $1 AND symbol = $2", [accountId, symbol]);
        await record(activity.id, accountId, symbol, net, "ordered", order.id, total > net ? `With $${(total - net).toFixed(2)} held from earlier dividends` : null);
    } catch (error) {
        // Already placed (the event came again after a restart)
        if (isHttpError(error) && /client_order_id must be unique/.test(error.message)) return record(activity.id, accountId, symbol, net, "ordered", null, null);
        await pool.query(
            `INSERT INTO drip_pending (account_id, symbol, amount) VALUES ($1, $2, $3) ON CONFLICT (account_id, symbol) DO UPDATE SET amount = EXCLUDED.amount`, [accountId, symbol, total.toFixed(2)]
        );
        await fail("failed", `The reinvestment order was refused (${error instanceof Error ? error.message : error}); $${total.toFixed(2)} is held for the next ${symbol} dividend.`);
    }
};

// GET /api/drip: the account's default, its positions' choices and what's held back
export const getDripSettings = async (accountId: string): Promise<DripSettings> => {
    const broker = getBroker();
    const [{ rows: settings }, { rows: pending }, { rows: recent }, positions] = await Promise.all([
        pool.query<{ symbol: string; enabled: boolean }>("SELECT symbol, enabled FROM drip_settings WHERE account_id = $1", [accountId]),
        pool.query<{ symbol: string; amount: string }>("SELECT symbol, amount FROM drip_pending WHERE account_id = $1 AND amount > 0 ORDER BY symbol", [accountId]),
        pool.query<{ symbol: string; amount: string; outcome: Outcome; note: string | null; created_at: Date }>(
            "SELECT symbol, amount, outcome, note, created_at FROM drip_reinvestments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20", [accountId]
        ),
        broker.listPositions(accountId)
    ]);
    const longs = positions.filter(position => Number(position.qty) > 0).map(position => position.symbol);
    const symbols = [...new Set([...longs, ...settings.map(({ symbol }) => symbol).filter(symbol => symbol !== "*")])].sort();
    const assets = await Promise.all(symbols.map(symbol => broker.getAsset(symbol).catch(() => null)));
    return {
        enabled: settings.find(({ symbol }) => symbol === "*")?.enabled ?? false,
        positions: symbols.map((symbol, index) => ({ symbol, enabled: settings.find(row => row.symbol === symbol)?.enabled ?? null, fractionable: assets[index]?.fractionable === true })),
        pending: pending.map(({ symbol, amount }) => ({ symbol, amount: Number(amount) })),
        recent: recent.map(row => ({ symbol: row.symbol, amount: Number(row.amount), outcome: row.outcome, note: row.note, createdAt: row.created_at.toISOString() }))
    };
};

// PUT /api/drip: the account's default ({ enabled }) or a position's choice ({ symbol, enabled }, null to follow the default)
export const setDripSetting = async (accountId: string, symbol: string | null, enabled: boolean | null) => {
    if (symbol && enabled === null) await pool.query("DELETE FROM drip_settings WHERE account_id = $1 AND symbol = $2", [accountId, symbol]);
    else await pool.query(
        `INSERT INTO drip_settings (account_id, symbol, enabled) VALUES ($1, $2, $3) ON CONFLICT (account_id, symbol) DO UPDATE SET enabled = EXCLUDED.enabled`, [accountId, symbol ?? "*", enabled === true]
    );
};
