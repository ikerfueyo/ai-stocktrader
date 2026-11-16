import "server-only";
import pool from "../db";
import { singleton } from "../cache";
import { brokerMode, getBroker } from "../broker";
import type { BrokerEvent, BrokerEventStream, EventCursor } from "../broker/broker";
import { notificationFor } from "../notificationRules";
import { forgetBrokerLedger, readsThroughBroker, recordOrderReason } from "../portfolio";
import { notify, userForAccount } from "../notifications";
import { reinvestDividend } from "./drip";
import { listAllTransfers } from "../brokerLedger";
import { addDays, easternParts } from "../../marketHours";

// The app's consumer of the broker's event streams (the simulator's sim_events, or Alpaca's SSE streams), run in the job leader only:
// each event becomes a notification for the account's user (notificationFor), and a cash dividend is reinvested when the position's
// reinvestment is on. Each stream resumes after the last event of it handled (event_checkpoints, app:<broker>:<stream>), so a restart
// neither repeats nor misses any; notifications and reinvestments are each made once even if an event comes twice. An event whose
// handling fails is kept (failed_events) and retried by the events job, with backoff, so it isn't lost and doesn't hold back the rest;
// if even that can't be written, the checkpoint isn't moved and the broker sends the event again.
// Checkpoints per broker: the simulator's event IDs and Alpaca's mean nothing to each other, so switching BROKER mustn't resume one
// broker's streams from the other's last event
const consumer = () => `app:${brokerMode()}`;
const STREAMS: BrokerEventStream[] = ["trades", "accounts", "transfers", "nta"];
const LABEL = "Broker events";
// Retries of a failed event: after 1 minute, doubling, 10 in all
const RETRY_BASE_MS = 60_000;
const MAX_ATTEMPTS = 10;

const state = singleton("eventConsumer", () => ({ stop: null as (() => void) | null }));

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// What an event does for the account's user; throws when any of it fails (each part is safe to run again)
const processEvent = async (event: BrokerEvent, userId: string) => {
    let payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.stream === "transfers" && ["COMPLETE", "RETURNED", "REJECTED"].includes(String(payload.status_to))) {
        // The event only names the transfer; its amount, type and direction say which one it is (left out if it can't be read)
        const transfer = (await listAllTransfers(getBroker(), event.accountId).catch(() => [])).find(({ id }) => id === payload.transfer_id);
        if (transfer) payload = { ...payload, transfer };
    }
    // Alpaca reports why an order ended only here, not on the order (the simulator keeps it on its orders)
    if (event.stream === "trades" && readsThroughBroker()) await recordOrderReason(event.accountId, payload);
    const draft = notificationFor({ id: event.id, stream: event.stream, payload });
    if (draft) await notify(userId, event.accountId, draft);
    if (event.stream === "nta" && payload.activity_type === "DIV" && payload.activity_sub_type !== "SDIV") {
        await reinvestDividend(userId, event.accountId, payload as { id: string; date?: string; net_amount?: string; symbol?: string });
    }
};

export const handleEvent = async (event: BrokerEvent) => {
    // A fill, transfer or activity the broker made itself changes the account the pages read
    forgetBrokerLedger(event.accountId);
    const userId = await userForAccount(event.accountId);
    if (userId) {
        try {
            await processEvent(event, userId);
        } catch (error) {
            // Kept for a retry, so one event's failure doesn't hold back the rest (a failure to keep it is thrown: not handled)
            console.error(`${LABEL}: ${event.stream} ${event.id}: ${errorText(error)}; retrying later`);
            await pool.query(
                `INSERT INTO failed_events (consumer, stream, event_id, account_id, at, payload, last_error, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 millisecond')
                 ON CONFLICT (consumer, stream, event_id) DO NOTHING`,
                [consumer(), event.stream, event.id, event.accountId, event.at, JSON.stringify(event.payload ?? {}), errorText(error).slice(0, 1000), RETRY_BASE_MS]
            );
        }
    }
    await pool.query(
        `INSERT INTO event_checkpoints (consumer, last_event_id, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (consumer) DO UPDATE SET last_event_id = GREATEST(event_checkpoints.last_event_id, EXCLUDED.last_event_id), updated_at = now()`,
        [`${consumer()}:${event.stream}`, event.id]
    );
};

// Retries the failed events that are due (the events job): done ones are dropped; the rest wait twice as long, until the last attempt,
// after which they're kept, not retried, for a look by hand
export const retryFailedEvents = async (now = new Date()) => {
    const { rows } = await pool.query<{ stream: BrokerEventStream; event_id: string; account_id: string; at: Date; payload: unknown; attempts: number }>(
        `SELECT stream, event_id, account_id, at, payload, attempts FROM failed_events WHERE consumer = $1 AND next_attempt_at <= $2 ORDER BY at LIMIT 50`, [consumer(), now]
    );
    let retried = 0;
    for (const row of rows) {
        const event: BrokerEvent = { id: row.event_id, stream: row.stream, accountId: row.account_id, at: row.at.toISOString(), payload: row.payload };
        try {
            const userId = await userForAccount(row.account_id);
            if (userId) await processEvent(event, userId);
            await pool.query("DELETE FROM failed_events WHERE consumer = $1 AND stream = $2 AND event_id = $3", [consumer(), row.stream, row.event_id]);
            retried++;
        } catch (error) {
            const attempts = row.attempts + 1;
            const giveUp = attempts >= MAX_ATTEMPTS;
            console.error(`${LABEL}: retry ${attempts} of ${row.stream} ${row.event_id}: ${errorText(error)}${giveUp ? "; giving up (kept in failed_events)" : ""}`);
            await pool.query(
                `UPDATE failed_events SET attempts = $4, last_error = $5, updated_at = now(),
                     next_attempt_at = CASE WHEN $6 THEN NULL ELSE now() + $7 * interval '1 millisecond' END
                 WHERE consumer = $1 AND stream = $2 AND event_id = $3`,
                [consumer(), row.stream, row.event_id, attempts, errorText(error).slice(0, 1000), giveUp, RETRY_BASE_MS * 2 ** (attempts - 1)]
            );
        }
    }
    return retried;
};

// Starts the subscription once per process (the events job calls it on every check, in the leader), each stream after its
// checkpoint (a stream without one yet after the one checkpoint kept for every stream before, app:<broker>); the first start ever
// begins with the events that come after it
export const startEventConsumer = async () => {
    if (state.stop) return false;
    const { rows } = await pool.query<{ consumer: string; last_event_id: string }>(
        "SELECT consumer, last_event_id FROM event_checkpoints WHERE consumer = $1 OR consumer LIKE $1 || ':%'", [consumer()]
    );
    const since: EventCursor = { streams: {}, shared: rows.find(row => row.consumer === consumer())?.last_event_id };
    for (const stream of STREAMS) {
        const checkpoint = rows.find(row => row.consumer === `${consumer()}:${stream}`);
        if (checkpoint) since.streams[stream] = checkpoint.last_event_id;
    }
    state.stop = getBroker().subscribe(STREAMS, handleEvent, since);
    const resumed = STREAMS.map(stream => since.streams[stream] ? `${stream} after ${since.streams[stream]}` : since.shared ? `${stream} near ${since.shared}` : null).filter(Boolean);
    console.log(`${LABEL}: subscribed${resumed.length > 0 ? ` (${resumed.join(", ")})` : ""}`);
    return true;
};

// Notifies each account's user of documents made in the past week that they haven't been told about (documents aren't events)
export const notifyNewDocuments = async (now = new Date(), accountId?: string) => {
    const since = addDays(easternParts(now).dateKey, -7);
    const { rows } = await pool.query<{ user_id: string; account_id: string }>(
        // The broker in use's accounts (a rejected application has no documents; Alpaca's are listed, and skipped if refused)
        `SELECT user_id, account_id FROM broker_accounts WHERE broker = $2 AND ($1::uuid IS NULL OR account_id = $1)
           AND (broker <> 'sim' OR account_id IN (SELECT id FROM sim_accounts WHERE status NOT IN ('REJECTED')))`, [accountId ?? null, brokerMode()]
    );
    let made = 0;
    for (const { user_id, account_id } of rows) {
        const documents = await getBroker().listDocuments(account_id, { start: since } as never).catch(() => []);
        for (const document of documents) {
            if (document.type === "trade_confirmation_json" || String(document.date) < since) continue;
            const created = await notify(user_id, account_id, {
                kind: "documents", title: `New document: ${document.name || `${String(document.type).replaceAll("_", " ")} of ${document.date}`}`, body: "", link: `/api/documents/${document.id}`, dedupeKey: `document:${document.id}`
            });
            if (created) made++;
        }
    }
    return made;
};
