import { UpstreamError } from "../../httpError";
import { BrokerError } from "../errors";
import type { AlpacaBrokerConfig } from "./config";
import { TokenSource } from "./auth";

// The Broker API over HTTP: JSON requests with the bearer token, retried once after a 401 with a fresh token and after a 429 (the
// request wasn't processed) once Retry-After has passed, and a GET retried once after a 5xx. Alpaca's refusals ({ code, message } with
// a 4xx) become BrokerErrors with the same status, code and message, so errorResponse answers as it does for the simulator's; 5xx
// replies, timeouts and network failures are the upstream's (UpstreamError, 502 or 504). Request bodies (an application carries the
// full SSN) are never logged or put in an error message.

export type Query = Record<string, string | number | boolean | string[] | null | undefined>;

export interface RequestOptions {
    query?: Query;
    body?: unknown;
    headers?: Record<string, string>;
}

const MAX_RATE_LIMIT_RETRIES = 2;

// Alpaca's codes start with the HTTP status (40310000 forbidden, 40410000 not found, 42210000 unprocessable), so a reply without one
// gets the status's generic code
export const fallbackCode = (status: number) => status * 100000 + 10000;

export const buildUrl = (base: string, path: string, query: Query = {}) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url.toString();
};

// The BrokerError (4xx) or UpstreamError (5xx) for a reply that isn't OK
export const errorFor = (status: number, text: string, what: string): BrokerError | UpstreamError => {
    let body: { code?: unknown; message?: unknown } = {};
    try {
        body = JSON.parse(text);
    } catch {
        // Not JSON: a proxy's page or a bare message
    }
    const message = typeof body.message === "string" && body.message ? body.message : text.trim().slice(0, 200) || `HTTP ${status}`;
    // A 401 even with a fresh token means the app's credentials are refused, not the user's session: never answered as a 401
    if (status >= 500 || status === 401) return new UpstreamError(`Alpaca ${what}: ${status} ${message}`, status === 504 ? 504 : 502);
    const code = typeof body.code === "number" ? body.code : Number(body.code) || fallbackCode(status);
    return new BrokerError(status, code, message);
};

const retryAfterMs = (response: Response) => {
    const header = response.headers.get("retry-after");
    const seconds = Number(header);
    if (header && Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = header ? Date.parse(header) : NaN;
    return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 30_000) : 1000;
};

export class AlpacaHttp {
    readonly tokens: TokenSource;
    private readonly fetch: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(readonly config: AlpacaBrokerConfig, tokens?: TokenSource) {
        this.tokens = tokens ?? new TokenSource(config);
        this.fetch = config.fetch ?? fetch;
        this.sleep = config.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    }

    url(path: string, query?: Query) {
        return buildUrl(this.config.apiUrl, path, query);
    }

    // The reply's body as JSON (undefined for an empty one, such as a 204)
    async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const response = await this.send(method, path, options);
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }

    // Sends a request and returns the OK response (or a redirect, with redirect: "manual"), or throws its error
    async send(method: string, path: string, options: RequestOptions & { redirect?: RequestRedirect } = {}): Promise<Response> {
        const what = `${method} ${path}`;
        let refreshed = false, rateLimited = 0, serverErrors = 0;
        for (;;) {
            const token = await this.tokens.token();
            let response: Response;
            try {
                response = await this.fetch(this.url(path, options.query), {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`, Accept: "application/json",
                        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
                        ...options.headers
                    },
                    body: options.body === undefined ? undefined : JSON.stringify(options.body),
                    redirect: options.redirect ?? "follow",
                    signal: AbortSignal.timeout(this.config.timeoutMs ?? 30000)
                });
            } catch (error) {
                const timedOut = error instanceof Error && error.name === "TimeoutError";
                throw new UpstreamError(`Alpaca ${what}: ${timedOut ? "timed out" : error instanceof Error ? error.message : error}`, timedOut ? 504 : 502);
            }
            if (response.ok || (options.redirect === "manual" && response.status >= 300 && response.status < 400)) return response;
            if (response.status === 401 && !refreshed) {
                this.tokens.invalidate(token);
                refreshed = true;
                await response.body?.cancel();
                continue;
            }
            if (response.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
                rateLimited++;
                await response.body?.cancel();
                await this.sleep(retryAfterMs(response));
                continue;
            }
            if (response.status >= 500 && method === "GET" && serverErrors < 1) {
                serverErrors++;
                await response.body?.cancel();
                await this.sleep(500);
                continue;
            }
            throw errorFor(response.status, await response.text().catch(() => ""), what);
        }
    }
}
