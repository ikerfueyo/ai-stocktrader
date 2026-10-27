import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ageOn, isValidItin, isValidSsn, maskTaxId, validateApplication, type AccountApplication } from "./kyc";

const TODAY = "2026-10-27";
const application = (overrides: Partial<AccountApplication> = {}): AccountApplication => ({
    contact: { email_address: "test@example.com", phone_number: "(555) 555-0100", street_address: ["20 N San Mateo Dr"], city: "San Mateo", state: "CA", postal_code: "94401", country: "USA" },
    identity: {
        given_name: "Test", family_name: "User", date_of_birth: "1990-01-15", tax_id: "123-45-6789", tax_id_type: "USA_SSN",
        country_of_citizenship: "USA", country_of_tax_residence: "USA", funding_source: ["employment_income"]
    },
    disclosures: { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false, employment_status: "retired" },
    agreements: ["customer_agreement", "account_agreement"],
    w9: { certified: true, backup_withholding: false },
    disclosures_delivered: { form_crs: true, privacy_notice: true },
    ...overrides
});

describe("Tax IDs", () => {
    test("SSNs can't have a 000, 666 or 9xx area, a 00 group or a 0000 serial", () => {
        assert.equal(isValidSsn("123-45-6789"), true);
        for (const ssn of ["000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000", "12345678"]) assert.equal(isValidSsn(ssn), false, ssn);
    });

    test("ITINs start with 9 and have a middle group in the IRS's ranges", () => {
        assert.equal(isValidItin("912-70-1234"), true);
        assert.equal(isValidItin("912-93-1234"), false);
        assert.equal(isValidItin("812-70-1234"), false);
    });

    test("only the last 4 digits are kept", () => {
        assert.equal(maskTaxId("123-45-6789"), "XXX-XX-6789");
    });
});

describe("validateApplication", () => {
    test("a complete application has no errors", () => {
        assert.deepEqual(validateApplication(application(), TODAY), {});
    });

    test("needs an adult U.S. tax resident at a residential U.S. address", () => {
        const errors = validateApplication(application({
            contact: { ...application().contact, street_address: ["PO Box 12"], state: "ZZ", postal_code: "123" },
            identity: { ...application().identity, date_of_birth: "2010-01-01", country_of_citizenship: "CAN" }
        }), TODAY);
        assert.deepEqual(Object.keys(errors).sort(), ["contact.postal_code", "contact.state", "contact.street_address", "identity.country_of_citizenship", "identity.date_of_birth"]);
    });

    test("a permanent resident who isn't a citizen is accepted", () => {
        const errors = validateApplication(application({ identity: { ...application().identity, country_of_citizenship: "MEX", permanent_resident: true } }), TODAY);
        assert.deepEqual(errors, {});
    });

    test("a yes to a disclosure needs its details", () => {
        const errors = validateApplication(application({
            disclosures: { ...application().disclosures, is_control_person: true, immediate_family_exposed: true }
        }), TODAY);
        assert.deepEqual(Object.keys(errors).sort(), ["disclosures.immediate_family_exposed", "disclosures.is_control_person"]);
    });

    test("needs the customer and account agreements, the W-9 and the disclosures, and options need a level and experience", () => {
        const errors = validateApplication(application({
            agreements: ["customer_agreement", "options_agreement"],
            w9: { certified: false, backup_withholding: false },
            disclosures_delivered: { form_crs: true, privacy_notice: false }
        }), TODAY);
        assert.deepEqual(Object.keys(errors).sort(), ["agreements", "disclosures_delivered", "identity.investment_experience_with_options", "options_level", "w9"]);
    });

    test("an employed applicant names the employer and position", () => {
        const errors = validateApplication(application({ disclosures: { ...application().disclosures, employment_status: "employed" } }), TODAY);
        assert.deepEqual(Object.keys(errors).sort(), ["disclosures.employer_name", "disclosures.employment_position"]);
    });

    test("ages count whole years", () => {
        assert.equal(ageOn("2008-10-28", TODAY), 17);
        assert.equal(ageOn("2008-10-27", TODAY), 18);
    });
});
