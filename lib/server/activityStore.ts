import "server-only";
import pool from "./db";
import { getBroker } from "./broker";
import { activityDay, CASH_ACTIVITY_TYPES, listAllActivities, mergeWindow, windowCursor } from "./brokerLedger";
import { easternParts } from "../marketHours";
import type { Activity } from "./broker/types";

// The app's copy of an account's activities at a broker it reads through the Broker interface (broker_activities), so a page load
// pages only what's new instead of the whole history, 100 at a time.
//
// Each read syncs it first: the first time, and then once a day, it reads everything and replaces the copy; otherwise it pages after
// a trailing cursor, the newest stored activity dated more than ACTIVITY_WINDOW_DAYS ago, and replaces what's stored after it, so
// activities that appear late (a fill missing for a moment, as the sandbox showed, or a fee posted after its trade) or are corrected
// within those days are picked up. The daily full read catches anything older. The broker's events already drop the app's 5-second
// cache (forgetBrokerLedger), so each event's change is paged on the next read. One sync per account at a time (an advisory lock).
const FULL_SYNC_MS = 24 * 60 * 60 * 1000;
// What the app reads: the fills and the cash activities
const STORED_TYPES = ["FILL", ...CASH_ACTIVITY_TYPES];

interface StoredRow {
    id: string;
    day: string;
    payload: Activity;
}

// The account's fills and cash activities, oldest first, after syncing the copy
export const syncedActivities = async (accountId: string, now = new Date()): Promise<Activity[]> => {
    const broker = getBroker();
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`activities:${accountId}`]);
        const { rows: [sync] } = await client.query<{ full_sync_at: Date }>("SELECT full_sync_at FROM broker_activity_sync WHERE account_id = $1", [accountId]);
        const stored = (await client.query<StoredRow>("SELECT id, day::text, payload FROM broker_activities WHERE account_id = $1 ORDER BY id", [accountId])).rows;
        const full = !sync || now.getTime() - sync.full_sync_at.getTime() >= FULL_SYNC_MS;
        const cursor = full ? null : windowCursor(stored, easternParts(now).dateKey);
        const fetched = await listAllActivities(broker, accountId, STORED_TYPES, cursor ?? undefined);
        const rows = fetched.filter(activity => typeof (activity as { id?: unknown }).id === "string")
            .map(activity => ({ id: String((activity as { id: string }).id), day: activityDay(activity), payload: activity }));
        await client.query(`DELETE FROM broker_activities WHERE account_id = $1 AND ($2::text IS NULL OR id > $2)`, [accountId, cursor]);
        if (rows.length > 0) {
            await client.query(
                `INSERT INTO broker_activities (account_id, id, activity_type, day, payload)
                 SELECT $1, r.id, r.activity_type, r.day::date, r.payload FROM jsonb_to_recordset($2::jsonb) AS r(id text, activity_type text, day text, payload jsonb)
                 ON CONFLICT (account_id, id) DO UPDATE SET activity_type = EXCLUDED.activity_type, day = EXCLUDED.day, payload = EXCLUDED.payload`,
                [accountId, JSON.stringify(rows.map(row => ({ ...row, activity_type: String((row.payload as { activity_type?: string }).activity_type ?? "") })))]
            );
        }
        if (full) {
            await client.query(
                `INSERT INTO broker_activity_sync (account_id, full_sync_at) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET full_sync_at = EXCLUDED.full_sync_at`,
                [accountId, now]
            );
        }
        await client.query("COMMIT");
        return mergeWindow(stored, rows, cursor).map(({ payload }) => payload);
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
};
