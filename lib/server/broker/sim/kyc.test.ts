import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { configurationError, decideApplication, decideOptionsApproval, defaultConfigurations, nextReviewStep, submittedDueAt, updateNeedsReview } from "./kyc";

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
    test("a margin account starts at 2x with shorting; a cash account at 1x without", () => {
        assert.equal(defaultConfigurations(["customer_agreement", "account_agreement", "margin_agreement"]).max_margin_multiplier, "2");
        const cash = defaultConfigurations(["customer_agreement", "account_agreement"]);
        assert.equal(cash.max_margin_multiplier, "1");
        assert.equal(cash.no_shorting, true);
    });

    test("margin, shorting and options can't go beyond what's agreed and approved", () => {
        const cash = { hasMarginAgreement: false, approvedOptionsLevel: 1 };
        assert.match(configurationError({ max_margin_multiplier: "2" }, cash)!, /margin agreement/);
        assert.match(configurationError({ no_shorting: false }, cash)!, /margin account/);
        assert.match(configurationError({ max_options_trading_level: 2 }, cash)!, /level 1/);
        assert.equal(configurationError({ max_margin_multiplier: "4", no_shorting: false }, { hasMarginAgreement: true, approvedOptionsLevel: 0 }), null);
        assert.match(configurationError({ max_margin_multiplier: "3" }, { hasMarginAgreement: true, approvedOptionsLevel: 0 })!, /1, 2 or 4/);
    });
});

describe("Options approval", () => {
    const agreements = ["customer_agreement" as const, "account_agreement" as const, "options_agreement" as const];

    test("needs the options agreement", () => {
        assert.deepEqual(decideOptionsApproval(1, { agreements: ["customer_agreement"] }), { status: "REJECTED", approvedLevel: 0 });
    });

    test("spreads need options experience; without it a lower level is approved", () => {
        assert.deepEqual(decideOptionsApproval(3, { agreements, stocksExperience: "over_5_years", optionsExperience: "1_to_5_years" }), { status: "APPROVED", approvedLevel: 3 });
        assert.deepEqual(decideOptionsApproval(3, { agreements, stocksExperience: "over_5_years", optionsExperience: "none" }), { status: "LOWER_LEVEL_APPROVED", approvedLevel: 2 });
        assert.deepEqual(decideOptionsApproval(2, { agreements, stocksExperience: "none", optionsExperience: "none" }), { status: "LOWER_LEVEL_APPROVED", approvedLevel: 1 });
    });
});
