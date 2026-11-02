// The shared brokerage scenarios (../scenarios.ts) against Alpaca's Broker API sandbox: npm run test:scenarios:sandbox, with the
// sandbox's ALPACA_BROKER_CLIENT_ID and ALPACA_BROKER_CLIENT_SECRET (in .env.local or the environment). It refuses production
// credentials. Each run opens new sandbox accounts with fake identities and moves sandbox money only. Alpaca does its work on its
// own clock, so advance waits (SCENARIO_WAIT_MS, default 5s) up to SCENARIO_PATIENCE times (default 60); market orders fill only
// while the market is open. What only the simulator can do (fix prices, age positions, post corporate actions, force a margin
// check, fill in parts) is skipped. SCENARIO_SYMBOLS (default AAPL,F) are the stocks traded; SCENARIO_OPTION_CONTRACT (an OCC symbol
// such as F261120C00012000) turns on the option trade. SCENARIO picks the scenarios whose names include it.
import { defineScenarioTests, type ScenarioHarness } from "../scenarios";
import { alpacaConfigFromEnv } from "./config";
import { AlpacaBroker } from "./client";
import { parseOptionSymbol } from "../../../options";

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
    const contract = process.env.SCENARIO_OPTION_CONTRACT;
    return {
        broker,
        symbols: { stock, other },
        patience: Number(process.env.SCENARIO_PATIENCE ?? 60),
        advance: () => new Promise(resolve => setTimeout(resolve, wait)),
        ...(contract ? { optionContract: { symbol: contract, underlying: parseOptionSymbol(contract)?.underlying ?? "" } } : {})
    };
};

defineScenarioTests("Brokerage scenarios (Alpaca sandbox)", makeHarness, process.env.SCENARIO);
