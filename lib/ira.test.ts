import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    ageOn, beneficiaryErrors, contributionError, contributionLimit, contributionTaxYears, distributionReasonError, distributionReasonsFor, distributionWithholding,
    reached59AndAHalf, spousalConsentMayBeNeeded, type BeneficiaryInput
} from "./ira";

describe("Contributions", () => {
    test("2026's limit is $7,500, with a $1,100 catch-up from the year you turn 50", () => {
        assert.equal(contributionLimit(2026, "1980-06-01"), 7500);
        assert.equal(contributionLimit(2026, "1976-12-31"), 8600, "50 on Dec 31, 2026");
        assert.equal(contributionLimit(2026, "1977-01-01"), 7500, "50 only in 2027");
        assert.equal(contributionLimit(2025, "1970-01-01"), 8000);
        assert.equal(contributionLimit(2027, "1980-06-01"), 7500, "a later year uses the newest known limit");
    });

    test("the prior year stays open until April 15", () => {
        assert.deepEqual(contributionTaxYears("2027-04-15"), [2027, 2026]);
        assert.deepEqual(contributionTaxYears("2027-04-16"), [2027]);
        assert.deepEqual(contributionTaxYears("2026-10-28"), [2026]);
    });

    test("a contribution fits what's left of the limit across the person's IRAs", () => {
        const base = { taxYear: 2026, day: "2026-10-28", dateOfBirth: "1990-01-01" };
        assert.equal(contributionError({ ...base, amount: 2500, contributed: 5000 }), null);
        assert.match(contributionError({ ...base, amount: 2500.01, contributed: 5000 })!, /exceed the 2026 IRA limit of \$7,500/);
        assert.match(contributionError({ ...base, taxYear: 2025, amount: 100, contributed: 0 })!, /deadline was 2026-04-15/);
        assert.match(contributionError({ ...base, taxYear: 2027, amount: 100, contributed: 0 })!, /hasn't started/);
    });
});

describe("Distributions", () => {
    test("ages and 59½", () => {
        assert.equal(ageOn("1967-10-29", "2026-10-28"), 58);
        assert.equal(reached59AndAHalf("1967-04-28", "2026-10-28"), true);
        assert.equal(reached59AndAHalf("1967-04-29", "2026-10-28"), false);
        assert.equal(reached59AndAHalf("1967-08-15", "2027-02-15"), true, "half a year on crosses into the next year");
    });

    test("the reason must fit the account type and the owner's age", () => {
        const young = { dateOfBirth: "1990-01-01", day: "2026-10-28", firstContributionYear: 2026 };
        const older = { dateOfBirth: "1960-01-01", day: "2026-10-28", firstContributionYear: 2026 };
        assert.equal(distributionReasonError("early_no_exception", "traditional", young), null);
        assert.match(distributionReasonError("normal", "traditional", young)!, /59½ or older; use early_no_exception/);
        assert.match(distributionReasonError("early_no_exception", "traditional", older)!, /under 59½; use normal/);
        assert.match(distributionReasonError("normal_roth", "traditional", older)!, /Roth IRA/);
        assert.match(distributionReasonError("normal_roth", "roth", older)!, /5 years/, "a Roth opened this year isn't qualified yet");
        assert.equal(distributionReasonError("normal_roth", "roth", { ...older, firstContributionYear: 2021 }), null);
        assert.match(distributionReasonError("hardship", "roth", older)!, /must be one of/);
        assert.deepEqual(distributionReasonsFor("roth", young), ["early_roth_no_exception", "excess_removal_roth", "excess_removal_1_year_prior_roth"]);
    });

    test("10% federal unless the owner opts out; withholding comes out of the amount", () => {
        assert.deepEqual(distributionWithholding(1000), { fedPct: 10, statePct: 0, fedAmount: 100, stateAmount: 0, net: 900 });
        assert.deepEqual(distributionWithholding(1000, { fedPct: 0, statePct: 5.5 }), { fedPct: 0, statePct: 5.5, fedAmount: 0, stateAmount: 55, net: 945 });
        assert.throws(() => distributionWithholding(1000, { fedPct: 60, statePct: 50 }), /more than 100/);
        assert.throws(() => distributionWithholding(1000, { fedPct: 10.255 }), /2 decimals/);
    });
});

describe("Beneficiaries", () => {
    const person = (overrides: Partial<BeneficiaryInput> = {}): BeneficiaryInput => ({
        given_name: "Jane", family_name: "Doe", date_of_birth: "1980-01-01", tax_id: "123-45-6789", relationship: "spouse", type: "primary", share_pct: "100", ...overrides
    });

    test("primaries add up to 100, and contingents too", () => {
        assert.deepEqual(beneficiaryErrors([person()], "2026-10-28"), []);
        assert.deepEqual(beneficiaryErrors([person({ share_pct: "60" }), person({ share_pct: "40", relationship: "other" })], "2026-10-28"), []);
        assert.match(beneficiaryErrors([person({ share_pct: "60" })], "2026-10-28").join(), /add up to 60%/);
        assert.match(beneficiaryErrors([person(), person({ type: "contingent", share_pct: "50" })], "2026-10-28").join(), /contingent beneficiaries' shares add up to 50%/);
        assert.match(beneficiaryErrors([person({ type: "contingent" })], "2026-10-28").join(), /at least one primary/);
    });

    test("each needs a name, a past birth date, an SSN and a share with up to 2 decimals; at most 6", () => {
        const errors = beneficiaryErrors([person({ given_name: " ", date_of_birth: "2030-01-01", tax_id: "000-12-3456", share_pct: "33.333" })], "2026-10-28").join(" | ");
        for (const text of ["name", "date of birth", "Social Security", "2 decimals"]) assert.ok(errors.includes(text), text);
        assert.match(beneficiaryErrors(Array.from({ length: 7 }, () => person({ share_pct: "100" })), "2026-10-28").join(), /at most 6/);
    });

    test("spousal consent may be needed in community property states without a spouse named", () => {
        assert.equal(spousalConsentMayBeNeeded("CA", [person({ relationship: "other" })]), true);
        assert.equal(spousalConsentMayBeNeeded("CA", [person()]), false);
        assert.equal(spousalConsentMayBeNeeded("IL", []), false);
    });
});
