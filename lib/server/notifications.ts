import "server-only";
import pool from "./db";
import { singleton } from "./cache";
import { NOTIFICATION_KINDS, type NotificationDraft, type NotificationKind } from "./notificationRules";
import type { NotificationItem, NotificationPreferences } from "../types";

// The app's notifications (any broker): stored per user from broker events (lib/server/automation/events.ts), price alerts, recurring
// buys, dividend reinvestment and new documents, each at most once (dedupe_key), unless the user turned the kind off in the app.
// Browser notifications are the pages' (Notification API), for the kinds the user chose.

const owners = singleton("accountOwners", () => new Map<string, string>());

// The user an account belongs to (null for one no user has, such as a test account)
export const userForAccount = async (accountId: string): Promise<string | null> => {
    const known = owners.get(accountId);
    if (known) return known;
    const { rows: [row] } = await pool.query<{ user_id: string }>("SELECT user_id FROM broker_accounts WHERE account_id = $1", [accountId]);
    if (row) owners.set(accountId, row.user_id);
    return row?.user_id ?? null;
};

export const getPreferences = async (userId: string): Promise<NotificationPreferences> => {
    const { rows } = await pool.query<{ kind: NotificationKind; in_app: boolean; browser: boolean }>("SELECT kind, in_app, browser FROM notification_preferences WHERE user_id = $1", [userId]);
    return Object.fromEntries(NOTIFICATION_KINDS.map(kind => {
        const row = rows.find(entry => entry.kind === kind);
        return [kind, { inApp: row?.in_app ?? true, browser: row?.browser ?? false }];
    })) as NotificationPreferences;
};

export const setPreferences = async (userId: string, preferences: Partial<NotificationPreferences>) => {
    for (const kind of NOTIFICATION_KINDS) {
        const preference = preferences[kind];
        if (!preference) continue;
        await pool.query(
            `INSERT INTO notification_preferences (user_id, kind, in_app, browser) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, kind) DO UPDATE SET in_app = EXCLUDED.in_app, browser = EXCLUDED.browser`,
            [userId, kind, preference.inApp !== false, preference.browser === true]
        );
    }
    return getPreferences(userId);
};

// Stores a notification for the user, unless its kind is off in the app or it was already made. Returns whether it was stored.
export const notify = async (userId: string, accountId: string | null, draft: NotificationDraft): Promise<boolean> => {
    const preferences = await getPreferences(userId);
    if (!preferences[draft.kind].inApp) return false;
    const { rowCount } = await pool.query(
        `INSERT INTO notifications (user_id, account_id, kind, title, body, link, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [userId, accountId, draft.kind, draft.title.slice(0, 300), draft.body.slice(0, 1000), draft.link, draft.dedupeKey]
    );
    return (rowCount ?? 0) > 0;
};

export const listNotifications = async (userId: string, limit = 50): Promise<{ items: NotificationItem[]; unread: number }> => {
    const [{ rows }, { rows: [{ count }] }] = await Promise.all([
        pool.query<{ id: string; kind: NotificationKind; title: string; body: string; link: string | null; created_at: Date; read_at: Date | null }>(
            "SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [userId, Math.min(200, Math.max(1, limit))]
        ),
        pool.query<{ count: string }>("SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId])
    ]);
    return {
        unread: Number(count),
        items: rows.map(row => ({ id: Number(row.id), kind: row.kind, title: row.title, body: row.body, link: row.link, createdAt: row.created_at.toISOString(), read: row.read_at !== null }))
    };
};

// Marks the user's notifications read: those given, or all of them
export const markRead = async (userId: string, ids?: number[]) => {
    await pool.query(
        "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2))", [userId, ids && ids.length > 0 ? ids : null]
    );
};
