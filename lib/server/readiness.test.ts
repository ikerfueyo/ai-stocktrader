import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkReadiness, readinessProblems } from "./readiness";
import { AGREEMENT_DOCUMENT_NAMES } from "../agreements";

const allDocuments = JSON.stringify(Object.fromEntries(AGREEMENT_DOCUMENT_NAMES.map(name => [name, { url: `https://docs.example.com/${name}.pdf`, revision: "1.2026.11" }])));
const production = {
    BROKER: "alpaca", ALPACA_BROKER_ENV: "production", ALPACA_BROKER_CLIENT_ID: "id", ALPACA_BROKER_CLIENT_SECRET: "secret",
    AGREEMENT_DOCUMENTS: allDocuments, ALPACA_ACH_DAILY_LIMIT: "50000", NODE_ENV: "production"
};

describe("readiness for Alpaca", () => {
    test("the simulator needs nothing", () => {
        assert.deepEqual(readinessProblems({}), { production: false, problems: [] });
        assert.deepEqual(readinessProblems({ BROKER: "sim", PRICE_OVERRIDES: "{}" }).problems, []);
    });

    test("the sandbox needs only the client credentials, and its problems are warnings", () => {
        const sandbox = readinessProblems({ BROKER: "alpaca", REQUIRE_MFA: "false", PRICE_OVERRIDES: "{}" });
        assert.equal(sandbox.production, false);
        assert.equal(sandbox.problems.length, 1);
        assert.match(sandbox.problems[0], /CLIENT_ID/);
        const warnings: string[] = [];
        checkReadiness({ BROKER: "alpaca" }, line => warnings.push(line));
        assert.equal(warnings.length, 1);
    });

    test("production with everything in place has no problems", () => {
        assert.deepEqual(readinessProblems(production), { production: true, problems: [] });
        assert.doesNotThrow(() => checkReadiness(production));
    });

    test("production refuses to start with anything meant for testing", () => {
        const { problems } = readinessProblems({
            ...production, AGREEMENT_DOCUMENTS: JSON.stringify({ customer_agreement: { url: "https://x", revision: "1" } }), REQUIRE_MFA: "false",
            ALPACA_ACH_DAILY_LIMIT: "", PLAID_CLIENT_ID: "p", PLAID_ENV: "sandbox", PRICE_OVERRIDES: "{\"F\": 10}", BACKGROUND_JOBS: "off", NODE_ENV: "development"
        });
        assert.equal(problems.length, 7);
        assert.match(problems[0], /account_agreement, margin_agreement, form_crs, ira_disclosure, privacy_notice/);
        assert.ok(problems.some(problem => /REQUIRE_MFA/.test(problem)));
        assert.ok(problems.some(problem => /PRICE_OVERRIDES/.test(problem)));
        assert.throws(() => checkReadiness({ ...production, REQUIRE_MFA: "false" }), /Not ready for Alpaca production/);
        // A malformed AGREEMENT_DOCUMENTS is a problem, not a crash
        assert.match(readinessProblems({ ...production, AGREEMENT_DOCUMENTS: "{\"nope\": {}}" }).problems[0], /unknown document/);
    });
});
