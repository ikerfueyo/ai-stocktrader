import { decodeTime, encodeTime } from "ulid";
import type { BrokerEvent, BrokerEventStream } from "../broker";

// Alpaca's event streams for the app's four (lib/server/broker/broker.ts), and their events in the shapes the simulator emits, so
// the app's consumer (lib/server/automation/events.ts) reads both alike. Each stream has its own ULIDs and its own resume parameter:
// trade updates are /v2/events/trades (since_id, event_id); account status and non-trade activities are v1 (since_ulid, event_ulid);
// transfer status comes from /v2/events/funding/status (since_id, event_id), since the legacy /v1/events/transfers/status isn't
// offered to new partners. The checkpoint the app keeps is one ID for all streams, the newest it handled; each stream's own IDs are
// time-ordered but not interleaved with the others', so a stream is resumed a few minutes before it (resumeId) and the repeats are
// dropped by ID (the consumer tolerates any that remain, as the interface requires).

export interface StreamDefinition {
    path: string;
    sinceParam: "since_id" | "since_ulid";
    idField: "event_id" | "event_ulid";
}

export const STREAMS: Record<BrokerEventStream, StreamDefinition> = {
    trades: { path: "/v2/events/trades", sinceParam: "since_id", idField: "event_id" },
    accounts: { path: "/v1/events/accounts/status", sinceParam: "since_ulid", idField: "event_ulid" },
    transfers: { path: "/v2/events/funding/status", sinceParam: "since_id", idField: "event_id" },
    nta: { path: "/v1/events/nta", sinceParam: "since_ulid", idField: "event_ulid" }
};

// How far before the checkpoint each stream starts again after a restart
export const RESUME_WINDOW_MS = 10 * 60_000;

// The lowest ULID of the time windowMs before id's (an invalid ID resumes from itself)
export const resumeId = (id: string, windowMs = RESUME_WINDOW_MS): string => {
    try {
        return `${encodeTime(Math.max(decodeTime(id) - windowMs, 0), 10)}${"0".repeat(16)}`;
    } catch {
        return id;
    }
};

const text = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

// One parsed event's BrokerEvent, or null when it isn't one the app follows (a funding event about a bank link or a wire bank) or
// lacks its ID or account
export const toBrokerEvent = (stream: BrokerEventStream, data: Record<string, unknown>): BrokerEvent | null => {
    const id = text(data[STREAMS[stream].idField]);
    const accountId = text(data.account_id);
    if (!id || !accountId) return null;
    const at = text(data.at) ?? text(data.timestamp) ?? new Date().toISOString();
    const event = (payload: Record<string, unknown>): BrokerEvent => ({ id, stream, accountId, at, payload: { ...payload, event_ulid: id, at } });
    switch (stream) {
        case "trades":
        case "accounts":
            return event(data);
        case "transfers":
            // The v1 TransferStatusEvent's fields, which the simulator emits
            if (data.entity_type !== "Transfer") return null;
            return event({ account_id: accountId, transfer_id: data.entity_id, status_from: data.status_from ?? "", status_to: data.status_to, ...(data.reason ? { reason: data.reason } : {}) });
        case "nta": {
            // An NTA event as the Activity the simulator emits (decimals as strings, like GET /v1/accounts/activities)
            const activity: Record<string, unknown> = {
                id: data.id, account_id: accountId, activity_type: data.entry_type, date: data.system_date, settle_date: data.settle_date,
                net_amount: text(data.net_amount) ?? "0", description: data.description ?? "", status: data.status ?? "executed"
            };
            if (data.symbol) activity.symbol = data.symbol;
            if (data.qty !== undefined && Number(data.qty) !== 0) activity.qty = text(data.qty);
            if (data.per_share_amount !== undefined) activity.per_share_amount = text(data.per_share_amount);
            if (data.price !== undefined) activity.price = text(data.price);
            if (data.cusip) activity.cusip = data.cusip;
            return event(activity);
        }
    }
};

// Event IDs already delivered, the most recent `capacity` of them
export class SeenIds {
    private readonly ids = new Set<string>();
    constructor(private readonly capacity = 10_000) {}

    // Records id; false when it was already seen
    add(id: string): boolean {
        if (this.ids.has(id)) return false;
        this.ids.add(id);
        if (this.ids.size > this.capacity) this.ids.delete(this.ids.values().next().value as string);
        return true;
    }
}
