import { HttpError, UpstreamError } from "../../httpError";

// Plaid, for linking a bank to an Alpaca account without the app ever seeing its numbers: Plaid Link (in the browser, with a link
// token from createLinkToken) gives a public token and the chosen account's ID; the server exchanges the public token for an access
// token and makes an Alpaca processor token from it (/processor/token/create, processor "alpaca"), which goes to Alpaca's ACH
// relationship request as processor_token. The access token isn't kept: the app makes no other Plaid calls, and the processor token
// is what Alpaca uses. Without PLAID_CLIENT_ID and PLAID_SECRET, banks are linked by routing and account number instead.

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidConfig {
    clientId: string;
    secret: string;
    environment: PlaidEnvironment;
    fetch?: typeof fetch;
}

const HOSTS: Record<PlaidEnvironment, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };

export const plaidConfigFromEnv = (env: Record<string, string | undefined> = process.env): PlaidConfig | null => {
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
    const environment = env.PLAID_ENV ?? "sandbox";
    if (environment !== "sandbox" && environment !== "production") throw new Error(`PLAID_ENV must be sandbox or production, not ${environment}`);
    return { clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, environment };
};

interface PlaidErrorBody {
    error_type?: string;
    error_code?: string;
    error_message?: string;
    display_message?: string | null;
}

export class PlaidClient {
    private readonly fetch: typeof fetch;
    constructor(private readonly config: PlaidConfig) {
        this.fetch = config.fetch ?? fetch;
    }

    private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
        let response: Response;
        try {
            response = await this.fetch(`${HOSTS[this.config.environment]}${path}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ client_id: this.config.clientId, secret: this.config.secret, ...body }),
                signal: AbortSignal.timeout(30000)
            });
        } catch (error) {
            throw new UpstreamError(`Plaid ${path}: ${error instanceof Error ? error.message : error}`, error instanceof Error && error.name === "TimeoutError" ? 504 : 502);
        }
        const reply = await response.json().catch(() => ({})) as T & PlaidErrorBody;
        if (!response.ok) {
            // The user's own problem (an expired or used public token, an account Plaid can't use) is a 400 with Plaid's message for
            // them; the app's (credentials, rate limits, Plaid's outages) a 502
            if (reply.error_type === "INVALID_INPUT" || reply.error_type === "ITEM_ERROR" || reply.error_type === "INVALID_REQUEST") {
                throw new HttpError(reply.display_message || reply.error_message || "Plaid couldn't link that account", 400);
            }
            throw new UpstreamError(`Plaid ${path}: ${response.status} ${reply.error_code ?? ""} ${reply.error_message ?? ""}`.trim());
        }
        return reply;
    }

    // A link token for Plaid Link, for the Auth product on U.S. accounts, tied to the app's user ID
    async createLinkToken(userId: string, clientName = "AI StockTrader"): Promise<{ link_token: string; expiration: string }> {
        return this.post("/link/token/create", { client_name: clientName, language: "en", country_codes: ["US"], user: { client_user_id: userId }, products: ["auth"] });
    }

    // Plaid Link's public token and chosen account as an Alpaca processor token
    async processorTokenFor(publicToken: string, plaidAccountId: string): Promise<string> {
        if (!publicToken || !plaidAccountId) throw new HttpError("A Plaid public token and account are required", 400);
        const { access_token } = await this.post<{ access_token: string }>("/item/public_token/exchange", { public_token: publicToken });
        const { processor_token } = await this.post<{ processor_token: string }>("/processor/token/create", { access_token, account_id: plaidAccountId, processor: "alpaca" });
        return processor_token;
    }
}
