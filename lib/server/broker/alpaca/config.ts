// AlpacaBroker's settings (BROKER=alpaca). Broker API partners authenticate with OAuth client credentials: the client ID and secret
// from the Broker dashboard are exchanged at authx for a 15-minute access token (docs.alpaca.markets/docs/authentication). Sandbox and
// production credentials aren't interchangeable, so ALPACA_BROKER_ENV picks both hosts; ALPACA_BROKER_API_URL and
// ALPACA_BROKER_AUTH_URL override them. Kept apart from the client so the tests can build one without the environment.
export type AlpacaEnvironment = "sandbox" | "production";

export interface AlpacaBrokerConfig {
    clientId: string;
    clientSecret: string;
    // The Broker API's base URL, such as https://broker-api.sandbox.alpaca.markets
    apiUrl: string;
    // The token endpoint, such as https://authx.sandbox.alpaca.markets/v1/oauth2/token
    authUrl: string;
    // Each request's timeout (the event streams stay open)
    timeoutMs?: number;
    // Injected by the tests; the global fetch otherwise
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

const HOSTS: Record<AlpacaEnvironment, { api: string; auth: string }> = {
    sandbox: { api: "https://broker-api.sandbox.alpaca.markets", auth: "https://authx.sandbox.alpaca.markets/v1/oauth2/token" },
    production: { api: "https://broker-api.alpaca.markets", auth: "https://authx.alpaca.markets/v1/oauth2/token" }
};

export const alpacaConfigFromEnv = (env: Record<string, string | undefined> = process.env): AlpacaBrokerConfig => {
    const environment = env.ALPACA_BROKER_ENV ?? "sandbox";
    if (environment !== "sandbox" && environment !== "production") throw new Error(`ALPACA_BROKER_ENV must be sandbox or production, not ${environment}`);
    const clientId = env.ALPACA_BROKER_CLIENT_ID, clientSecret = env.ALPACA_BROKER_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("BROKER=alpaca needs ALPACA_BROKER_CLIENT_ID and ALPACA_BROKER_CLIENT_SECRET (the Broker API's OAuth client credentials)");
    return {
        clientId, clientSecret,
        apiUrl: (env.ALPACA_BROKER_API_URL ?? HOSTS[environment].api).replace(/\/+$/, ""),
        authUrl: env.ALPACA_BROKER_AUTH_URL ?? HOSTS[environment].auth,
        timeoutMs: Number(env.ALPACA_BROKER_TIMEOUT_MS ?? 30000)
    };
};
