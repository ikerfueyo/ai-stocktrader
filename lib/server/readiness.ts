// What going live with Alpaca needs from the environment (docs/going-live.md), checked when the server starts (instrumentation.ts)
// and by npm run check:alpaca. Pure, so it's unit tested: it reads only the environment it's given.
//
// With BROKER=alpaca the Broker API's client credentials must be set. With production credentials (ALPACA_BROKER_ENV=production) the
// server refuses to start while anything that only suits testing is in place: placeholder agreements, two-step verification turned
// off, the daily ACH limit left at its guess, Plaid's sandbox, or one of the test-only switches.
import { AGREEMENT_DOCUMENT_NAMES, parseAgreementDocuments, PLACEHOLDER_REVISION } from "../agreements";

type Env = Record<string, string | undefined>;

// Switches for local testing only: fixed prices, a forced market session, the simulator read as Alpaca, made-up hard-to-borrow
// stocks, and no background jobs (no event consumer, so no notifications, order reasons or dividend reinvestment)
const TEST_ONLY = ["PRICE_OVERRIDES", "MARKET_HOURS_OVERRIDE", "BROKER_LEDGER", "SIM_HTB_SYMBOLS"] as const;

export interface Readiness {
    // Whether the problems stop the server: only with Alpaca's production credentials
    production: boolean;
    problems: string[];
}

export const readinessProblems = (env: Env): Readiness => {
    const broker = env.BROKER ?? "sim";
    if (broker !== "alpaca") return { production: false, problems: [] };
    const problems: string[] = [];
    if (!env.ALPACA_BROKER_CLIENT_ID || !env.ALPACA_BROKER_CLIENT_SECRET) {
        problems.push("ALPACA_BROKER_CLIENT_ID and ALPACA_BROKER_CLIENT_SECRET (the Broker API's OAuth client credentials) aren't set");
    }
    const production = (env.ALPACA_BROKER_ENV ?? "sandbox") === "production";
    if (!production) return { production, problems };

    try {
        const documents = parseAgreementDocuments(env.AGREEMENT_DOCUMENTS);
        const placeholders = AGREEMENT_DOCUMENT_NAMES.filter(name => documents[name].revision === PLACEHOLDER_REVISION);
        if (placeholders.length > 0) problems.push(`AGREEMENT_DOCUMENTS has no real document for ${placeholders.join(", ")}`);
    } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
    }
    if ((env.REQUIRE_MFA ?? "true").toLowerCase() !== "true") problems.push("REQUIRE_MFA is off: trading and moving money must need two-step verification");
    if (!env.ALPACA_ACH_DAILY_LIMIT) problems.push("ALPACA_ACH_DAILY_LIMIT isn't set: confirm Alpaca's production ACH limit and set it");
    if ((env.PLAID_CLIENT_ID || env.PLAID_SECRET) && env.PLAID_ENV !== "production") problems.push("PLAID_ENV isn't production while Plaid's keys are set");
    for (const name of TEST_ONLY) if (env[name]) problems.push(`${name} is set, which is for local testing only`);
    if (env.BACKGROUND_JOBS === "off") problems.push("BACKGROUND_JOBS=off: without the jobs there's no event consumer (notifications, order reasons, dividend reinvestment)");
    if (env.NODE_ENV !== "production") problems.push(`NODE_ENV is ${env.NODE_ENV ?? "unset"}: production credentials need a production build (next build, next start)`);
    return { production, problems };
};

// At startup: production problems stop the server; elsewhere they're warnings
export const checkReadiness = (env: Env, log: (line: string) => void = console.warn) => {
    const { production, problems } = readinessProblems(env);
    if (problems.length === 0) return;
    const list = problems.map(problem => `  - ${problem}`).join("\n");
    if (production) throw new Error(`Not ready for Alpaca production:\n${list}`);
    log(`Alpaca readiness:\n${list}`);
};
