import type { BrokerEvent, BrokerEventStream } from "../broker";
import type { AlpacaHttp } from "./http";
import { resumeId, SeenIds, STREAMS, toBrokerEvent } from "./events";

// Server-sent events (html.spec.whatwg.org/multipage/server-sent-events.html) from Alpaca's event streams: a parser, and a
// subscription that keeps one connection per stream open, reconnects after a drop with backoff (from the stream's last event, so
// nothing is missed), and hands each new event to the handler one at a time, across streams, in the order they arrive.

export interface SseMessage {
    data: string;
    id?: string;
    event?: string;
}

// Turns chunks of the stream into messages: data lines joined, a blank line dispatching, comments (": you are reading too slowly")
// passed to onComment
export class SseParser {
    private buffer = "";
    private data: string[] = [];
    private id: string | undefined;
    private event: string | undefined;

    constructor(private readonly onComment: (comment: string) => void = () => {}) {}

    push(chunk: string): SseMessage[] {
        this.buffer += chunk;
        const messages: SseMessage[] = [];
        const lines = this.buffer.split(/\r\n|\r|\n/);
        // The last piece may be a partial line (a lone \r may be followed by \n in the next chunk, which then ends an empty line:
        // harmless, since an empty line without data dispatches nothing)
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (line === "") {
                if (this.data.length > 0) messages.push({ data: this.data.join("\n"), id: this.id, event: this.event });
                this.data = [];
                this.event = undefined;
                continue;
            }
            if (line.startsWith(":")) {
                this.onComment(line.slice(1).trim());
                continue;
            }
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "data") this.data.push(value);
            else if (field === "id") this.id = value;
            else if (field === "event") this.event = value;
        }
        return messages;
    }
}

export interface SubscriptionOptions {
    // Waits between reconnections, doubling from the first to the last
    minBackoffMs?: number;
    maxBackoffMs?: number;
    log?: (message: string) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

// Subscribes to the streams asked for, after sinceId (each stream from RESUME_WINDOW_MS before it), or from now without it (Alpaca
// sends no history without a since parameter). Returns a function that closes every connection.
export const subscribeToStreams = (
    http: AlpacaHttp, streams: BrokerEventStream[], handler: (event: BrokerEvent) => Promise<void>, sinceId?: string, options: SubscriptionOptions = {}
): (() => void) => {
    const controller = new AbortController();
    const { signal } = controller;
    const minBackoff = options.minBackoffMs ?? 1000, maxBackoff = options.maxBackoffMs ?? 30_000;
    const log = options.log ?? (message => console.error(`Alpaca events: ${message}`));
    const sleep = options.sleep ?? abortableSleep;
    const fetcher = http.config.fetch ?? fetch;
    // The handler runs for one event at a time, whichever stream it's from
    let queue = Promise.resolve();
    const deliver = (event: BrokerEvent) => {
        queue = queue.then(() => signal.aborted ? undefined : handler(event)).catch(error => log(`${event.stream} ${event.id}: ${error instanceof Error ? error.message : error}`));
        return queue;
    };

    const follow = async (stream: BrokerEventStream) => {
        const definition = STREAMS[stream];
        const seen = new SeenIds();
        // The stream's own newest event, which a reconnection resumes from exactly
        let last = null as string | null;
        let backoff = minBackoff;
        while (!signal.aborted) {
            const since = last ?? (sinceId ? resumeId(sinceId) : undefined);
            try {
                const token = await http.tokens.token();
                const response = await fetcher(http.url(definition.path, since ? { [definition.sinceParam]: since } : {}), {
                    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal
                });
                if (response.status === 401) http.tokens.invalidate(token);
                if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new Error(`${response.status} ${response.statusText}`);
                }
                const parser = new SseParser(comment => log(`${stream}: ${comment}`));
                const decoder = new TextDecoder();
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                    for (const message of parser.push(decoder.decode(chunk, { stream: true }))) {
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(message.data);
                        } catch {
                            log(`${stream}: unreadable event ${message.data.slice(0, 80)}`);
                            continue;
                        }
                        for (const data of Array.isArray(parsed) ? parsed : [parsed]) {
                            const id = data?.[definition.idField];
                            if (typeof id !== "string" || !seen.add(id)) continue;
                            if (last === null || id > last) last = id;
                            const event = toBrokerEvent(stream, data);
                            if (event) await deliver(event);
                        }
                    }
                    backoff = minBackoff;
                }
                // The server ended the stream (a deploy, an internal error); reconnect from the last event
                if (!signal.aborted) log(`${stream}: stream ended, reconnecting`);
            } catch (error) {
                if (signal.aborted) break;
                log(`${stream}: ${error instanceof Error ? error.message : error}; reconnecting in ${Math.round(backoff / 1000)}s`);
            }
            await sleep(backoff, signal);
            backoff = Math.min(backoff * 2, maxBackoff);
        }
    };

    for (const stream of streams) void follow(stream);
    return () => controller.abort();
};
