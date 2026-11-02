import "server-only";
import { alpacaConfigFromEnv } from "./config";
import { AlpacaBroker } from "./client";
import { PlaidClient, plaidConfigFromEnv } from "./plaid";

export { AlpacaBroker } from "./client";

// AlpacaBroker from the environment (ALPACA_BROKER_*), for getBroker()
export const createAlpacaBroker = () => new AlpacaBroker(alpacaConfigFromEnv());

// Plaid from the environment (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV), or null when it isn't configured
export const getPlaid = (): PlaidClient | null => {
    const config = plaidConfigFromEnv();
    return config ? new PlaidClient(config) : null;
};
