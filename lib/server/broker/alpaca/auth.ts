import { UpstreamError } from "../../httpError";
import type { AlpacaBrokerConfig } from "./config";

// The Broker API's access token: client credentials posted as a form (the secret in the body, client_secret_post) to the token
// endpoint, which answers { access_token, expires_in: 899, token_type: "Bearer" }. Alpaca asks partners not to fetch a token per
// call, so it's kept until a minute before it expires, concurrent callers share one refresh, and a 401 drops it (invalidate) so the
// next call fetches a new one.
const REFRESH_EARLY_MS = 60_000;

interface TokenReply {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
}

export class TokenSource {
    private current: { token: string; expiresAt: number } | null = null;
    private pending: Promise<string> | null = null;
    private readonly fetch: typeof fetch;
    private readonly now: () => number;

    constructor(private readonly config: AlpacaBrokerConfig) {
        this.fetch = config.fetch ?? fetch;
        this.now = config.now ?? Date.now;
    }

    async token(): Promise<string> {
        if (this.current && this.current.expiresAt - REFRESH_EARLY_MS > this.now()) return this.current.token;
        this.pending ??= this.issue().finally(() => {
            this.pending = null;
        });
        return this.pending;
    }

    // Drops the token a request was refused with (a newer one fetched meanwhile is kept)
    invalidate(token: string) {
        if (this.current?.token === token) this.current = null;
    }

    private async issue(): Promise<string> {
        const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret });
        let response: Response;
        try {
            response = await this.fetch(this.config.authUrl, {
                method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                signal: AbortSignal.timeout(this.config.timeoutMs ?? 30000)
            });
        } catch (error) {
            throw new UpstreamError(`Alpaca authentication: ${error instanceof Error ? error.message : error}`, error instanceof Error && error.name === "TimeoutError" ? 504 : 502);
        }
        const reply = await response.json().catch(() => ({})) as TokenReply & { error?: string; error_description?: string };
        if (!response.ok || !reply.access_token) {
            // The credentials are the app's, not the user's: a refusal is a server problem (502), never passed on as a 401
            throw new UpstreamError(`Alpaca authentication: ${response.status} ${reply.error_description ?? reply.error ?? "no access token"}`);
        }
        const issuedAt = this.now();
        this.current = { token: reply.access_token, expiresAt: issuedAt + (Number(reply.expires_in) || 899) * 1000 };
        return reply.access_token;
    }
}
