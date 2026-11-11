// npm run check:alpaca: whether the app is ready to connect to Alpaca with the credentials in .env.local (or the environment). Read
// only: it changes nothing at Alpaca. It lists the readiness problems (lib/server/readiness.ts), then gets an OAuth token, the clock,
// this month's calendar and the accounts, and opens each event stream for a few seconds from 10 minutes back (CHECK_SINCE_MINUTES;
// a synthetic ULID, as the app resumes after a restart), printing what each answered. Exits 1 if anything failed.
import { monotonicFactory } from "ulid";
import { alpacaConfigFromEnv } from "../lib/server/broker/alpaca/config";
import { AlpacaBroker } from "../lib/server/broker/alpaca/client";
import { STREAMS, resumeId } from "../lib/server/broker/alpaca/events";
import { readinessProblems } from "../lib/server/readiness";
import type { BrokerEventStream } from "../lib/server/broker/broker";

try {
    process.loadEnvFile(".env.local");
} catch {
    // The variables may come from the environment instead
}

const STREAM_SECONDS = Number(process.env.CHECK_STREAM_SECONDS ?? 5);
// How far back the streams start (the app's restart window by default)
const SINCE_MINUTES = Number(process.env.CHECK_SINCE_MINUTES ?? 10);
let failed = false;
const report = (ok: boolean, what: string, detail = "") => {
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};
const step = async (what: string, run: () => Promise<string>) => {
    try {
        report(true, what, await run());
    } catch (error) {
        report(false, what, error instanceof Error ? error.message : String(error));
    }
};

const main = async () => {
    const env: Record<string, string | undefined> = { ...process.env, BROKER: "alpaca" };
    const { production, problems } = readinessProblems(env);
    console.log(`Alpaca ${production ? "production" : "sandbox"} (${env.ALPACA_BROKER_ENV ?? "sandbox"})`);
    if (problems.length === 0) report(true, "readiness");
    for (const problem of problems) report(!production && !/CLIENT/.test(problem), "readiness", problem);

    const broker = new AlpacaBroker(alpacaConfigFromEnv(env));
    await step("OAuth token", async () => {
        await broker.http.tokens.token();
        return "issued";
    });
    await step("clock", async () => {
        const clock = await broker.getClock();
        return `market ${clock.is_open ? "open" : "closed"}, next open ${clock.next_open}`;
    });
    await step("calendar", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const days = await broker.getCalendar(today.slice(0, 8) + "01", today.slice(0, 8) + "28");
        return `${days.length} trading days this month to the 28th`;
    });
    await step("accounts", async () => {
        const accounts = await broker.http.json<unknown[]>("GET", "/v1/accounts");
        return `${accounts.length} listed`;
    });

    // Each stream from 10 minutes back (CHECK_SINCE_MINUTES), as the app resumes after a restart: does Alpaca accept a synthetic ID?
    const since = resumeId(monotonicFactory()(), SINCE_MINUTES * 60_000);
    const token = await broker.http.tokens.token().catch(() => null);
    for (const stream of Object.keys(STREAMS) as BrokerEventStream[]) {
        if (!token) {
            report(false, `stream ${stream}`, "no token");
            continue;
        }
        const definition = STREAMS[stream];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STREAM_SECONDS * 1000);
        try {
            const response = await fetch(broker.http.url(definition.path, { [definition.sinceParam]: since }), {
                headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal: controller.signal
            });
            if (!response.ok || !response.body) {
                report(false, `stream ${stream}`, `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
                continue;
            }
            let events = 0, comments = 0;
            const commentTexts = new Set<string>();
            const decoder = new TextDecoder();
            const kinds = new Set<string>();
            try {
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                    for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
                        if (line.startsWith("data:")) {
                            events++;
                            try {
                                const data = JSON.parse(line.slice(5));
                                for (const item of Array.isArray(data) ? data : [data]) {
                                    kinds.add(String(item.event ?? item.entry_type ?? item.status_to ?? item.entity_type ?? Object.keys(item).slice(0, 3).join("/")));
                                }
                            } catch {
                                // Partial line across chunks
                            }
                        } else if (line.startsWith(":")) {
                            comments++;
                            commentTexts.add(line.slice(1).trim().slice(0, 80));
                        }
                    }
                }
            } catch {
                // Aborted after STREAM_SECONDS
            }
            report(true, `stream ${stream}`, `${definition.sinceParam}=${since}: ${response.status}, ${events} events in ${STREAM_SECONDS}s${kinds.size ? ` (${[...kinds].slice(0, 8).join(", ")})` : ""}${comments ? `, ${comments} comments (${[...commentTexts].slice(0, 3).join("; ")})` : ""}`);
        } catch (error) {
            report(false, `stream ${stream}`, error instanceof Error ? error.message : String(error));
        } finally {
            clearTimeout(timer);
        }
    }
    process.exit(failed ? 1 : 0);
};

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
