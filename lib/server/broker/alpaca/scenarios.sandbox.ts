// The shared brokerage scenarios (../scenarios.ts) against Alpaca's Broker API sandbox: npm run test:scenarios:sandbox, with the
// sandbox's ALPACA_BROKER_CLIENT_ID and ALPACA_BROKER_CLIENT_SECRET (in .env.local or the environment). It refuses production
// credentials. Each run opens new sandbox accounts with fake identities and moves sandbox money only. Alpaca does its work on its
// own clock, so advance waits (SCENARIO_WAIT_MS, default 5s) up to SCENARIO_PATIENCE times (default 60); market orders fill only
// while the market is open. What only the simulator can do (fix prices, age positions, post corporate actions, force a margin
// check, fill in parts) is skipped. SCENARIO_SYMBOLS (default AAPL,F) are the stocks traded. SCENARIO picks the scenarios whose names
// include it. SCENARIO_ACCOUNT_ID (an account's ID, not its number) is an existing account for what a new one can't do in the
// sandbox: the short and close position scenarios (margin, which support enables per account, with shorting) and the withdraw and wire
// ones (a deposit is held for 7 business days). It must be ACTIVE, flat in the two symbols with no open orders in them, and have at
// least $3,000 withdrawable; each run withdraws $1,515 from it (with the wire's fee). Without it those are skipped or wait on
// shorting, and the close scenario, which needs a new account's deposit withdrawn, is always skipped.
import { defineScenarioTests, type ScenarioHarness } from "../scenarios";
import { alpacaConfigFromEnv } from "./config";
import { AlpacaBroker } from "./client";

try {
    process.loadEnvFile(".env.local");
} catch {
    // The variables may come from the environment instead
}
if ((process.env.ALPACA_BROKER_ENV ?? "sandbox") !== "sandbox") throw new Error("The scenarios run against Alpaca's sandbox only (ALPACA_BROKER_ENV=sandbox)");

const makeHarness = async (): Promise<ScenarioHarness> => {
    const broker = new AlpacaBroker(alpacaConfigFromEnv());
    const [stock = "AAPL", other = "F"] = (process.env.SCENARIO_SYMBOLS ?? "").split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
    const wait = Number(process.env.SCENARIO_WAIT_MS ?? 5000);
    return {
        broker,
        symbols: { stock, other },
        patience: Number(process.env.SCENARIO_PATIENCE ?? 60),
        advance: () => new Promise(resolve => setTimeout(resolve, wait)),
        ...(process.env.SCENARIO_ACCOUNT_ID ? { account: process.env.SCENARIO_ACCOUNT_ID.trim() } : {})
    };
};

defineScenarioTests("Brokerage scenarios (Alpaca sandbox)", makeHarness, process.env.SCENARIO);
