import "server-only";
import pool from "../db";
import { singleton } from "../cache";
import { getBroker } from "../broker";
import type { BrokerEvent, BrokerEventStream } from "../broker/broker";
import { notificationFor } from "../notificationRules";
import { notify, userForAccount } from "../notifications";
import { reinvestDividend } from "./drip";
import { addDays, easternParts } from "../../marketHours";

// The app's consumer of the broker's event streams (the simulator's sim_events, Alpaca's SSE later), run in the job leader only:
// each event becomes a notification for the account's user (notificationFor), and a cash dividend is reinvested when the position's
// reinvestment is on. It resumes after the last event it handled (event_checkpoints), so a restart neither repeats nor misses any;
// notifications and reinvestments are each made once even if an event comes twice.
const CONSUMER = "app";
const STREAMS: BrokerEventStream[] = ["trades", "accounts", "transfers", "nta"];
const LABEL = "Broker events";

const state = singleton("eventConsumer", () => ({ stop: null as (() => void) | null }));

export const handleEvent = async (event: BrokerEvent) => {
    const userId = await userForAccount(event.accountId);
    if (userId) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        try {
            const draft = notificationFor({ id: event.id, stream: event.stream, payload });
            if (draft) await notify(userId, event.accountId, draft);
            if (event.stream === "nta" && payload.activity_type === "DIV" && payload.activity_sub_type !== "SDIV") {
                await reinvestDividend(userId, event.accountId, payload as { id: string; date?: string; net_amount?: string; symbol?: string });
            }
        } catch (error) {
            // One event's failure doesn't hold back the rest
            console.error(`${LABEL}: ${event.stream} ${event.id}: ${error instanceof Error ? error.message : error}`);
        }
    }
    await pool.query(
        `INSERT INTO event_checkpoints (consumer, last_event_id, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (consumer) DO UPDATE SET last_event_id = GREATEST(event_checkpoints.last_event_id, EXCLUDED.last_event_id), updated_at = now()`,
        [CONSUMER, event.id]
    );
};

// Starts the subscription once per process (the events job calls it on every check, in the leader); the first start ever begins
// with the events that come after it
export const startEventConsumer = async () => {
    if (state.stop) return false;
    const { rows: [checkpoint] } = await pool.query<{ last_event_id: string }>("SELECT last_event_id FROM event_checkpoints WHERE consumer = $1", [CONSUMER]);
    state.stop = getBroker().subscribe(STREAMS, handleEvent, checkpoint?.last_event_id);
    console.log(`${LABEL}: subscribed${checkpoint ? ` after ${checkpoint.last_event_id}` : ""}`);
    return true;
};

// Notifies each account's user of documents made in the past week that they haven't been told about (documents aren't events)
export const notifyNewDocuments = async (now = new Date(), accountId?: string) => {
    const since = addDays(easternParts(now).dateKey, -7);
    const { rows } = await pool.query<{ user_id: string; account_id: string }>(
        "SELECT user_id, account_id FROM broker_accounts WHERE account_id IN (SELECT id FROM sim_accounts WHERE status NOT IN ('REJECTED')) AND ($1::uuid IS NULL OR account_id = $1)", [accountId ?? null]
    );
    let made = 0;
    for (const { user_id, account_id } of rows) {
        const documents = await getBroker().listDocuments(account_id, { start: since } as never).catch(() => []);
        for (const document of documents) {
            if (document.type === "trade_confirmation_json" || String(document.date) < since) continue;
            const created = await notify(user_id, account_id, {
                kind: "documents", title: `New document: ${document.name}`, body: "", link: `/api/documents/${document.id}`, dedupeKey: `document:${document.id}`
            });
            if (created) made++;
        }
    }
    return made;
};
