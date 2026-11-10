import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { configurationError, decideApplication, defaultConfigurations, nextReviewStep, submittedDueAt, updateNeedsReview } from "./kyc";

const noDisclosures = { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false };
const applicant = (familyName: string, disclosures = noDisclosures) => ({
    identity: { given_name: "Test", family_name: familyName, date_of_birth: "1990-01-15", tax_id: "", tax_id_type: "USA_SSN" as const, country_of_citizenship: "USA", country_of_tax_residence: "USA" as const, funding_source: ["savings" as const] },
    disclosures
});
const now = new Date("2026-10-27T15:00:00Z");

describe("KYC decisions", () => {
    test("an ordinary application is approved", () => {
        assert.equal(decideApplication(applicant("User")).status, "APPROVED");
    });

    test("the test names reject, ask for documents or send to review", () => {
        assert.equal(decideApplication(applicant("Reject")).status, "REJECTED");
        assert.equal(decideApplication(applicant("ActionRequired")).status, "ACTION_REQUIRED");
        assert.equal(decideApplication(applicant("review")).status, "APPROVAL_PENDING");
    });

    test("a politically exposed applicant always gets a manual review", () => {
        const decision = decideApplication(applicant("User", { ...noDisclosures, is_politically_exposed: true }));
        assert.equal(decision.status, "APPROVAL_PENDING");
        assert.deepEqual(decision.kyc_results?.indeterminate, { PEP: {} });
    });
});

describe("The account review steps", () => {
    const state = (status: Parameters<typeof nextReviewStep>[0]["status"], dueAt: Date | null, documentsUploaded = false) => ({ status, dueAt, documentsUploaded });

    test("a submitted application is decided once due, and an approved one becomes active", () => {
        assert.equal(nextReviewStep(state("SUBMITTED", submittedDueAt(now)), applicant("User"), now), null, "not due yet");
        const decided = nextReviewStep(state("SUBMITTED", now), applicant("User"), now)!;
        assert.equal(decided.status, "APPROVED");
        assert.deepEqual(nextReviewStep(state("APPROVED", decided.dueAt), applicant("User"), now), { status: "ACTIVE", dueAt: null });
    });

    test("a manual review is approved after its delay", () => {
        const pending = nextReviewStep(state("SUBMITTED", now), applicant("Review"), now)!;
        assert.equal(pending.status, "APPROVAL_PENDING");
        assert.ok(pending.dueAt! > now);
        assert.equal(nextReviewStep(state("APPROVAL_PENDING", pending.dueAt), applicant("Review"), now), null);
        assert.equal(nextReviewStep(state("APPROVAL_PENDING", pending.dueAt), applicant("Review"), pending.dueAt!)!.status, "APPROVED");
    });

    test("an account waiting on documents goes to review once they're uploaded; a rejected one stays rejected", () => {
        assert.equal(nextReviewStep(state("ACTION_REQUIRED", null), applicant("ActionRequired"), now), null);
        assert.equal(nextReviewStep(state("ACTION_REQUIRED", null, true), applicant("ActionRequired"), now)!.status, "APPROVAL_PENDING");
        assert.equal(nextReviewStep(state("REJECTED", null), applicant("Reject"), now), null);
    });
});

describe("Profile changes", () => {
    const current = { contact: { city: "San Mateo", phone_number: "5555550100" }, identity: { given_name: "Test" }, disclosures: { is_control_person: false, employer_name: "Acme" } };

    test("a new address, name or employer is reviewed; a new phone number isn't", () => {
        assert.equal(updateNeedsReview(current, { contact: { city: "Oakland" } }), true);
        assert.equal(updateNeedsReview(current, { disclosures: { employer_name: "Other" } }), true);
        assert.equal(updateNeedsReview(current, { contact: { phone_number: "5555550199" } }), false);
        assert.equal(updateNeedsReview(current, { contact: { city: "San Mateo" } }), false, "unchanged");
    });

    test("a disclosure turning true is reviewed", () => {
        assert.equal(updateNeedsReview(current, { disclosures: { is_control_person: true } }), true);
        assert.equal(updateNeedsReview(current, { disclosures: { is_control_person: false } }), false);
    });
});

describe("Trading configurations", () => {
    test("no account starts with its own multiplier, as on Alpaca; a margin account starts with shorting, a cash account without", () => {
        const margin = defaultConfigurations(["customer_agreement", "account_agreement", "margin_agreement"]);
        assert.equal("max_margin_multiplier" in margin, false);
        assert.equal(margin.no_shorting, false);
        const cash = defaultConfigurations(["customer_agreement", "account_agreement"]);
        assert.equal("max_margin_multiplier" in cash, false);
        assert.equal(cash.no_shorting, true);
    });

    test("margin and shorting can't go beyond what's agreed, and options aren't offered", () => {
        const cash = { hasMarginAgreement: false };
        assert.match(configurationError({ max_margin_multiplier: "2" }, cash)!, /margin agreement/);
        assert.match(configurationError({ no_shorting: false }, cash)!, /margin account/);
        assert.match(configurationError({ max_options_trading_level: 1 }, { hasMarginAgreement: true })!, /Options trading isn't offered/);
        assert.equal(configurationError({ max_options_trading_level: 0 }, cash), null);
        assert.equal(configurationError({ max_margin_multiplier: "4", no_shorting: false }, { hasMarginAgreement: true }), null);
        assert.match(configurationError({ max_margin_multiplier: "3" }, { hasMarginAgreement: true })!, /1, 2 or 4/);
        assert.match(configurationError({ max_margin_multiplier: "2" }, { hasMarginAgreement: true, brokerLimit: 1 })!, /exceeds the current limit 1/);
        assert.match(configurationError({ max_margin_multiplier: "4" }, { hasMarginAgreement: true, brokerLimit: 2 })!, /exceeds the current limit 2/);
        assert.equal(configurationError({ max_margin_multiplier: "2" }, { hasMarginAgreement: true, brokerLimit: 2 }), null);
    });
});
