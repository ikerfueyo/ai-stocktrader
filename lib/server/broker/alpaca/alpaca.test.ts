import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decodeTime, ulid } from "ulid";
import { BrokerError } from "../errors";
import { HttpError, UpstreamError } from "../../httpError";
import { alpacaConfigFromEnv, type AlpacaBrokerConfig } from "./config";
import { TokenSource } from "./auth";
import { buildUrl, errorFor, fallbackCode } from "./http";
import { AlpacaBroker, redactAccount } from "./client";
import { resumeId, SeenIds, toBrokerEvent, RESUME_WINDOW_MS } from "./events";
import { SseParser } from "./sse";
import { PlaidClient } from "./plaid";
import type { BrokerEvent } from "../broker";
import type { Account } from "../types";

// A fetch that records each call and answers from respond (a token request gets a fresh token unless respond handles it)
interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    redirect?: RequestRedirect;
}
const mockFetch = (respond: (call: Call, index: number) => Response | Promise<Response> | undefined) => {
    const calls: Call[] = [];
    let tokens = 0;
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        const call: Call = { url: String(input), method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : String(init.body), redirect: init.redirect };
        calls.push(call);
        const reply = await respond(call, calls.length - 1);
        if (reply) return reply;
        if (call.url.includes("/oauth2/token")) return json({ access_token: `token-${++tokens}`, expires_in: 899, token_type: "Bearer" });
        throw new Error(`unexpected request ${call.method} ${call.url}`);
    }) as typeof fetch;
    return { fetcher, calls, apiCalls: () => calls.filter(({ url }) => !url.includes("/oauth2/token")) };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const config = (fetcher: typeof fetch, extra: Partial<AlpacaBrokerConfig> = {}): AlpacaBrokerConfig => ({
    clientId: "client", clientSecret: "secret", apiUrl: "https://broker.test", authUrl: "https://auth.test/v1/oauth2/token",
    fetch: fetcher, sleep: async () => {}, ...extra
});
const ACCOUNT = "c8f1ef5d-edc0-4f23-9ee4-378f19cb92a4";

describe("configuration", () => {
    test("the sandbox by default, production on request, and credentials required", () => {
        const sandbox = alpacaConfigFromEnv({ ALPACA_BROKER_CLIENT_ID: "id", ALPACA_BROKER_CLIENT_SECRET: "secret" });
        assert.equal(sandbox.apiUrl, "https://broker-api.sandbox.alpaca.markets");
        assert.equal(sandbox.authUrl, "https://authx.sandbox.alpaca.markets/v1/oauth2/token");
        const live = alpacaConfigFromEnv({ ALPACA_BROKER_CLIENT_ID: "id", ALPACA_BROKER_CLIENT_SECRET: "secret", ALPACA_BROKER_ENV: "production" });
        assert.equal(live.apiUrl, "https://broker-api.alpaca.markets");
        assert.equal(live.authUrl, "https://authx.alpaca.markets/v1/oauth2/token");
        assert.equal(alpacaConfigFromEnv({ ALPACA_BROKER_CLIENT_ID: "id", ALPACA_BROKER_CLIENT_SECRET: "s", ALPACA_BROKER_API_URL: "https://x.test/" }).apiUrl, "https://x.test");
        assert.throws(() => alpacaConfigFromEnv({ ALPACA_BROKER_CLIENT_ID: "id" }), /ALPACA_BROKER_CLIENT_SECRET/);
        assert.throws(() => alpacaConfigFromEnv({ ALPACA_BROKER_CLIENT_ID: "id", ALPACA_BROKER_CLIENT_SECRET: "s", ALPACA_BROKER_ENV: "paper" }), /sandbox or production/);
    });
});

describe("OAuth client credentials", () => {
    test("posts the credentials as a form and keeps the token until a minute before it expires", async () => {
        let now = 1_000_000;
        const { fetcher, calls } = mockFetch(() => undefined);
        const tokens = new TokenSource(config(fetcher, { now: () => now }));
        assert.equal(await tokens.token(), "token-1");
        const [request] = calls;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "https://auth.test/v1/oauth2/token");
        assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
        assert.deepEqual(Object.fromEntries(new URLSearchParams(request.body)), { grant_type: "client_credentials", client_id: "client", client_secret: "secret" });
        now += 800_000;
        assert.equal(await tokens.token(), "token-1");
        // 899 seconds less the minute's margin
        now += 40_000;
        assert.equal(await tokens.token(), "token-2");
        assert.equal(calls.length, 2);
    });

    test("concurrent callers share one refresh, and a refused token is dropped", async () => {
        const { fetcher, calls } = mockFetch(() => undefined);
        const tokens = new TokenSource(config(fetcher));
        assert.deepEqual(await Promise.all([tokens.token(), tokens.token(), tokens.token()]), ["token-1", "token-1", "token-1"]);
        tokens.invalidate("token-0");
        assert.equal(await tokens.token(), "token-1");
        tokens.invalidate("token-1");
        assert.equal(await tokens.token(), "token-2");
        assert.equal(calls.length, 2);
    });

    test("refused credentials are the server's problem (502), not a 401", async () => {
        const { fetcher } = mockFetch(() => json({ error: "invalid_client", error_description: "bad secret" }, 401));
        await assert.rejects(new TokenSource(config(fetcher)).token(), (error: unknown) => error instanceof UpstreamError && error.status === 502 && /bad secret/.test(error.message));
    });
});

describe("requests", () => {
    test("URLs skip empty parameters and join lists", () => {
        assert.equal(buildUrl("https://b.test", "/v1/assets", { status: "active", attributes: ["fractional_eh_enabled", "has_options"], asset_class: undefined, x: null, y: "" }),
            "https://b.test/v1/assets?status=active&attributes=fractional_eh_enabled%2Chas_options");
    });

    test("an order is posted as JSON with the bearer token to the account's orders", async () => {
        const order = { id: "o1", status: "accepted" };
        const { fetcher, apiCalls } = mockFetch(({ url }) => url.includes("/orders") ? json(order) : undefined);
        const broker = new AlpacaBroker(config(fetcher));
        const request = { symbol: "AAPL", side: "buy", type: "limit", time_in_force: "day", qty: "2", limit_price: "180.50", client_order_id: "c1" } as const;
        assert.deepEqual(await broker.createOrder(ACCOUNT, request), order);
        const [call] = apiCalls();
        assert.equal(call.method, "POST");
        assert.equal(call.url, `https://broker.test/v1/trading/accounts/${ACCOUNT}/orders`);
        assert.equal(call.headers.authorization, "Bearer token-1");
        assert.equal(call.headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(call.body!), request);
    });

    test("each method's path, method and query", async () => {
        const { fetcher, apiCalls } = mockFetch(({ url, method }) => {
            if (url.includes("/oauth2/token")) return undefined;
            if (method === "DELETE" && url.endsWith("/orders")) return json([{ id: "a", status: 200 }, { id: "b", status: 500, body: {} }], 207);
            if (url.includes("/options/approvals")) return json({ options_approvals: [] });
            return method === "DELETE" ? new Response(null, { status: 204 }) : json([]);
        });
        const broker = new AlpacaBroker(config(fetcher));
        await broker.listOrders(ACCOUNT, { status: "open", symbols: "AAPL,F", limit: 50 });
        await broker.getOrderByClientOrderId(ACCOUNT, "recurring-1-2026-10-28");
        await broker.closePosition(ACCOUNT, "BRK.B", { percentage: "50" });
        await broker.listActivities(ACCOUNT, { activity_types: "FILL,DIV", page_size: 100 } as never);
        await broker.cancelOrder(ACCOUNT, "o1");
        assert.deepEqual(await broker.cancelAllOrders(ACCOUNT), [{ id: "a", status: 200 }, { id: "b", status: 500 }]);
        await broker.listOptionsApprovals(ACCOUNT);
        await broker.getCalendar("2026-10-01", "2026-10-31");
        await broker.exerciseOption(ACCOUNT, "F261120C00012000", { qty: "1" });
        await broker.listTransfers(ACCOUNT, { direction: "INCOMING" } as never);
        await broker.deleteAchRelationship(ACCOUNT, "r1");
        const requests = apiCalls().map(({ method, url }) => `${method} ${url.replace("https://broker.test", "").replaceAll(ACCOUNT, "{id}")}`);
        assert.deepEqual(requests, [
            "GET /v1/trading/accounts/{id}/orders?status=open&symbols=AAPL%2CF&limit=50",
            "GET /v1/trading/accounts/{id}/orders:by_client_order_id?client_order_id=recurring-1-2026-10-28",
            "DELETE /v1/trading/accounts/{id}/positions/BRK.B?percentage=50",
            "GET /v1/accounts/activities?activity_types=FILL%2CDIV&page_size=100&account_id={id}",
            "DELETE /v1/trading/accounts/{id}/orders/o1",
            "DELETE /v1/trading/accounts/{id}/orders",
            "GET /v1/accounts/options/approvals?account_id={id}",
            "GET /v1/calendar?start=2026-10-01&end=2026-10-31",
            "POST /v1/trading/accounts/{id}/positions/F261120C00012000/exercise",
            "GET /v1/accounts/{id}/transfers?direction=INCOMING",
            "DELETE /v1/accounts/{id}/ach_relationships/r1"
        ]);
    });

    test("a bank linked with a Plaid processor token sends only the token", async () => {
        const { fetcher, apiCalls } = mockFetch(({ url }) => url.includes("ach_relationships") ? json({ id: "r1", status: "QUEUED" }) : undefined);
        await new AlpacaBroker(config(fetcher)).createAchRelationship(ACCOUNT, { processor_token: "processor-sandbox-1" } as never);
        assert.deepEqual(JSON.parse(apiCalls()[0].body!), { processor_token: "processor-sandbox-1" });
    });

    test("paged lists are followed to the limit asked for", async () => {
        const { fetcher, apiCalls } = mockFetch(({ url }) => {
            if (!url.includes("/options/contracts")) return undefined;
            const token = new URL(url).searchParams.get("page_token");
            const contracts = Array.from({ length: 3 }, (_, index) => ({ symbol: `${token ?? "p0"}-${index}` }));
            return json({ option_contracts: contracts, next_page_token: token === "p2" ? null : token ? `p${Number(token.slice(1)) + 1}` : "p1" });
        });
        const contracts = await new AlpacaBroker(config(fetcher)).listOptionContracts({ underlying_symbols: "F", limit: 7 });
        assert.deepEqual(contracts.map(({ symbol }) => symbol), ["p0-0", "p0-1", "p0-2", "p1-0", "p1-1", "p1-2", "p2-0"]);
        assert.deepEqual(apiCalls().map(({ url }) => new URL(url).searchParams.get("limit")), ["7", "4", "1"]);
    });

    test("configurations are the trading account's user configurations", async () => {
        const { fetcher } = mockFetch(({ url }) => url.endsWith("/account") ? json({ id: ACCOUNT, user_configurations: null }) : undefined);
        assert.deepEqual(await new AlpacaBroker(config(fetcher)).getConfigurations(ACCOUNT), {});
    });

    test("a document is fetched from its pre-signed link without the bearer token", async () => {
        const { fetcher, calls } = mockFetch(({ url }) => {
            if (url.endsWith("/download")) return new Response(null, { status: 301, headers: { Location: "https://files.test/doc.pdf?sig=1" } });
            if (url.startsWith("https://files.test")) return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } });
            return undefined;
        });
        const file = await new AlpacaBroker(config(fetcher)).downloadDocument(ACCOUNT, "d1");
        assert.equal(file.contentType, "application/pdf");
        assert.deepEqual([...file.body], [37, 80, 68, 70]);
        const download = calls.find(({ url }) => url.endsWith("/download"))!, presigned = calls.find(({ url }) => url.startsWith("https://files.test"))!;
        assert.equal(download.redirect, "manual");
        assert.equal(presigned.headers.authorization, undefined);
    });

    test("locates aren't in the Broker API", async () => {
        const { fetcher } = mockFetch(() => undefined);
        await assert.rejects(new AlpacaBroker(config(fetcher)).listLocateQuotes(), (error: unknown) => error instanceof BrokerError && error.status === 501);
    });
});

describe("retries", () => {
    test("a 401 fetches a new token and retries once", async () => {
        const { fetcher, calls } = mockFetch(({ url, headers }) => url.includes("/v1/clock") ? (headers.authorization === "Bearer token-1" ? json({ message: "expired" }, 401) : json({ is_open: true })) : undefined);
        assert.deepEqual(await new AlpacaBroker(config(fetcher)).getClock(), { is_open: true });
        assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), ["/v1/oauth2/token", "/v1/clock", "/v1/oauth2/token", "/v1/clock"]);
    });

    test("a second 401 is the app's credentials, answered as a 502", async () => {
        const { fetcher, apiCalls } = mockFetch(({ url }) => url.includes("/v1/clock") ? json({ message: "unauthorized" }, 401) : undefined);
        await assert.rejects(new AlpacaBroker(config(fetcher)).getClock(), (error: unknown) => error instanceof UpstreamError && !(error instanceof BrokerError) && error.status === 502);
        assert.equal(apiCalls().length, 2);
    });

    test("a 429 waits for Retry-After, up to twice", async () => {
        const waits: number[] = [];
        let attempts = 0;
        const { fetcher } = mockFetch(({ url }) => url.includes("/v1/clock") ? (++attempts < 3 ? json({ message: "rate limit" }, 429, { "Retry-After": "2" }) : json({ is_open: false })) : undefined);
        const broker = new AlpacaBroker(config(fetcher, { sleep: async ms => { waits.push(ms); } }));
        assert.deepEqual(await broker.getClock(), { is_open: false });
        assert.deepEqual(waits, [2000, 2000]);
        attempts = -10;
        await assert.rejects(broker.getClock(), (error: unknown) => error instanceof BrokerError && error.status === 429);
    });

    test("a GET is retried once after a 5xx; a POST isn't", async () => {
        let gets = 0;
        const { fetcher, apiCalls } = mockFetch(({ url, method }) => {
            if (url.includes("/oauth2/token")) return undefined;
            if (method === "GET") return ++gets === 1 ? json({ message: "busy" }, 503) : json([]);
            return json({ message: "internal error" }, 500);
        });
        const broker = new AlpacaBroker(config(fetcher));
        assert.deepEqual(await broker.listPositions(ACCOUNT), []);
        await assert.rejects(broker.createTransfer(ACCOUNT, { transfer_type: "ach", direction: "INCOMING", amount: "100", relationship_id: "r1" } as never),
            (error: unknown) => error instanceof UpstreamError && error.status === 502 && /internal error/.test(error.message));
        assert.equal(apiCalls().filter(({ method }) => method === "POST").length, 1);
    });
});

describe("errors", () => {
    test("Alpaca's refusals keep their status, code and message", () => {
        const error = errorFor(403, JSON.stringify({ code: 40310000, message: "insufficient buying power" }), "POST /orders");
        assert.ok(error instanceof BrokerError);
        assert.equal(error.status, 403);
        assert.equal(error.code, 40310000);
        assert.equal(error.message, "insufficient buying power");
    });

    test("a reply without Alpaca's shape gets its status's code", () => {
        const error = errorFor(422, "symbol is required\n", "POST /orders") as BrokerError;
        assert.equal(error.code, fallbackCode(422));
        assert.equal(error.code, 42210000);
        assert.equal(error.message, "symbol is required");
        assert.equal((errorFor(404, "", "GET /x") as BrokerError).message, "HTTP 404");
    });

    test("5xx replies are the upstream's, a 504 kept as a timeout", () => {
        const bad = errorFor(500, "{}", "GET /v1/clock");
        assert.ok(bad instanceof UpstreamError && !(bad instanceof BrokerError));
        assert.equal(bad.status, 502);
        assert.equal(errorFor(504, "", "GET /v1/clock").status, 504);
    });

    test("network failures and timeouts", async () => {
        const failing = (error: Error) => mockFetch(({ url }) => {
            if (url.includes("/v1/clock")) throw error;
            return undefined;
        }).fetcher;
        const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        await assert.rejects(new AlpacaBroker(config(failing(timeout))).getClock(), (error: unknown) => error instanceof UpstreamError && error.status === 504);
        await assert.rejects(new AlpacaBroker(config(failing(new TypeError("fetch failed")))).getClock(), (error: unknown) => error instanceof UpstreamError && error.status === 502);
    });

    test("the request body never appears in an error", async () => {
        const { fetcher } = mockFetch(({ url }) => url.endsWith("/v1/accounts") ? json({ code: 42210000, message: "invalid identity" }, 422) : undefined);
        await assert.rejects(new AlpacaBroker(config(fetcher)).createAccount({ identity: { tax_id: "123-45-6789" } } as never),
            (error: unknown) => error instanceof BrokerError && !error.message.includes("6789"));
    });
});

describe("tax IDs", () => {
    test("the full SSN is sent to Alpaca and never returned", async () => {
        const { fetcher, apiCalls } = mockFetch(({ url, body }) => url.endsWith("/v1/accounts") ? json({ id: ACCOUNT, status: "SUBMITTED", ...JSON.parse(body!) }) : undefined);
        const account = await new AlpacaBroker(config(fetcher)).createAccount({
            account_type: "ira", identity: { given_name: "Test", family_name: "User", tax_id: "123-45-6789", tax_id_type: "USA_SSN" },
            beneficiaries: [{ given_name: "Kid", family_name: "User", tax_id: "987-65-4321" }]
        } as never);
        assert.equal(JSON.parse(apiCalls()[0].body!).identity.tax_id, "123-45-6789");
        assert.equal(account.identity?.tax_id, "XXX-XX-6789");
        assert.equal((account as unknown as { beneficiaries: { tax_id: string }[] }).beneficiaries[0].tax_id, "xxx-xx-xxxx");
        assert.ok(!JSON.stringify(account).includes("123-45") && !JSON.stringify(account).includes("4321"));
    });

    test("an account without a tax ID is left alone", () => {
        const account = { id: ACCOUNT, identity: { given_name: "A", family_name: "B" } } as unknown as Account;
        assert.deepEqual(redactAccount(account), account);
    });
});

describe("events", () => {
    test("SSE messages across chunks, with comments and CRLF", () => {
        const comments: string[] = [];
        const parser = new SseParser(comment => comments.push(comment));
        assert.deepEqual(parser.push(": you are reading too slowly, dropped 10 messages\r\ndata: {\"a\""), []);
        assert.deepEqual(parser.push(":1}\r\n\r\ndata: line one\ndata: line two\nid: 7\n"), [{ data: "{\"a\":1}", id: undefined, event: undefined }]);
        assert.deepEqual(parser.push("\n\n"), [{ data: "line one\nline two", id: "7", event: undefined }]);
        assert.deepEqual(comments, ["you are reading too slowly, dropped 10 messages"]);
    });

    test("a stream resumes a few minutes before the checkpoint", () => {
        const id = ulid(Date.UTC(2026, 9, 28, 15));
        const resumed = resumeId(id);
        assert.equal(decodeTime(resumed), Date.UTC(2026, 9, 28, 15) - RESUME_WINDOW_MS);
        assert.ok(resumed < id);
        assert.equal(resumed.length, 26);
        assert.equal(resumeId("not-a-ulid"), "not-a-ulid");
    });

    test("seen IDs are kept up to their capacity", () => {
        const seen = new SeenIds(2);
        assert.equal(seen.add("a"), true);
        assert.equal(seen.add("a"), false);
        seen.add("b");
        seen.add("c");
        assert.equal(seen.add("a"), true);
    });

    test("events take the simulator's shapes", () => {
        const trade = toBrokerEvent("trades", { event_id: "01T", account_id: ACCOUNT, at: "2026-10-28T14:00:00Z", event: "fill", order: { symbol: "AAPL" }, qty: "2", price: "180" });
        assert.equal(trade?.id, "01T");
        assert.equal((trade?.payload as { event: string }).event, "fill");
        const funding = { event_id: "01F", account_id: ACCOUNT, at: "2026-10-28T14:00:00Z", entity_type: "Transfer", entity_id: "t1", status_from: "QUEUED", status_to: "COMPLETE", correspondent: "X" };
        assert.deepEqual(toBrokerEvent("transfers", funding)?.payload, { account_id: ACCOUNT, transfer_id: "t1", status_from: "QUEUED", status_to: "COMPLETE", event_ulid: "01F", at: "2026-10-28T14:00:00Z" });
        assert.equal(toBrokerEvent("transfers", { ...funding, entity_type: "BankRelationship" }), null);
        const nta = toBrokerEvent("nta", {
            event_ulid: "01N", id: "20261028::abc", account_id: ACCOUNT, at: "2026-10-28T21:00:00Z", system_date: "2026-10-28", settle_date: "2026-10-28",
            entry_type: "DIV", net_amount: 12.5, qty: 0, per_share_amount: 0.25, symbol: "F", description: "Cash DIV @ 0.25"
        });
        assert.deepEqual(nta?.payload, {
            id: "20261028::abc", account_id: ACCOUNT, activity_type: "DIV", date: "2026-10-28", settle_date: "2026-10-28", net_amount: "12.5", description: "Cash DIV @ 0.25",
            status: "executed", symbol: "F", per_share_amount: "0.25", event_ulid: "01N", at: "2026-10-28T21:00:00Z"
        });
        assert.equal(toBrokerEvent("accounts", { account_id: ACCOUNT, status_to: "ACTIVE" }), null);
    });

    test("a subscription resumes each stream, drops repeats, reconnects after the last event and stops", async () => {
        const sse = (...events: unknown[]) => new Response(new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                for (const event of events) {
                    // Split each message in two chunks, as the network may
                    const text = `data: ${JSON.stringify(event)}\n\n`;
                    controller.enqueue(encoder.encode(text.slice(0, 10)));
                    controller.enqueue(encoder.encode(text.slice(10)));
                }
                controller.close();
            }
        }), { headers: { "Content-Type": "text/event-stream" } });
        const checkpoint = ulid(Date.UTC(2026, 9, 28, 15));
        const fill = (id: string) => ({ event_id: id, account_id: ACCOUNT, at: "2026-10-28T15:00:00Z", event: "fill", order: {} });
        const connections: string[] = [];
        let tradeConnections = 0;
        const { fetcher } = mockFetch(({ url, headers }) => {
            if (url.includes("/oauth2/token")) return undefined;
            assert.equal(headers.accept, "text/event-stream");
            connections.push(url.replace("https://broker.test", ""));
            if (url.includes("/v2/events/trades")) {
                tradeConnections++;
                // The first connection repeats an event; the second picks up after the last one
                return tradeConnections === 1 ? sse(fill("01A"), fill("01A"), fill("01B")) : sse(fill("01C"));
            }
            return sse({ event_ulid: "01X", account_id: ACCOUNT, at: "2026-10-28T15:00:00Z", status_from: "SUBMITTED", status_to: "ACTIVE" });
        });
        const received: BrokerEvent[] = [];
        let stop = () => {};
        const done = new Promise<void>(resolve => {
            const broker = new AlpacaBroker(config(fetcher), { minBackoffMs: 1, maxBackoffMs: 1, log: () => {}, sleep: () => new Promise(next => setTimeout(next, 1)) });
            stop = broker.subscribe(["trades", "accounts"], async event => {
                received.push(event);
                if (received.filter(({ stream }) => stream === "trades").length === 3) resolve();
            }, checkpoint);
        });
        await done;
        stop();
        const trades = received.filter(({ stream }) => stream === "trades").map(({ id }) => id);
        assert.deepEqual(trades, ["01A", "01B", "01C"]);
        assert.ok(received.some(({ stream, id }) => stream === "accounts" && id === "01X"));
        const resumed = resumeId(checkpoint);
        assert.ok(connections.includes(`/v2/events/trades?since_id=${resumed}`));
        assert.ok(connections.includes(`/v1/events/accounts/status?since_ulid=${resumed}`));
        assert.ok(connections.includes("/v2/events/trades?since_id=01B"));
        // Stopped: no more connections
        const count = connections.length;
        await new Promise(next => setTimeout(next, 20));
        assert.ok(connections.length <= count + 2);
    });
});

describe("Plaid", () => {
    test("a public token becomes an Alpaca processor token", async () => {
        const { fetcher, calls } = mockFetch(({ url }) => url.endsWith("/item/public_token/exchange") ? json({ access_token: "access-sandbox-1", item_id: "i" })
            : url.endsWith("/processor/token/create") ? json({ processor_token: "processor-sandbox-1", request_id: "r" }) : undefined);
        const plaid = new PlaidClient({ clientId: "pc", secret: "ps", environment: "sandbox", fetch: fetcher });
        assert.equal(await plaid.processorTokenFor("public-sandbox-1", "acct-1"), "processor-sandbox-1");
        assert.deepEqual(calls.map(({ url }) => url), ["https://sandbox.plaid.com/item/public_token/exchange", "https://sandbox.plaid.com/processor/token/create"]);
        assert.deepEqual(JSON.parse(calls[1].body!), { client_id: "pc", secret: "ps", access_token: "access-sandbox-1", account_id: "acct-1", processor: "alpaca" });
    });

    test("the user's problems are 400s, the app's 502s", async () => {
        const reply = (body: unknown) => new PlaidClient({ clientId: "pc", secret: "ps", environment: "sandbox", fetch: mockFetch(() => json(body, 400)).fetcher });
        await assert.rejects(reply({ error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN", error_message: "x", display_message: "Link the bank again" }).processorTokenFor("p", "a"),
            (error: unknown) => error instanceof HttpError && !(error instanceof UpstreamError) && error.status === 400 && error.message === "Link the bank again");
        await assert.rejects(reply({ error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }).processorTokenFor("p", "a"), (error: unknown) => error instanceof UpstreamError);
    });
});
