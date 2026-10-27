// Account application rules shared by the onboarding form and the server (lib/server/broker/sim): what Alpaca's
// POST /v1/accounts needs for a U.S. individual account, checked field by field, and how a tax ID is masked. Pure, so it can be
// unit tested and run in the browser.

export const US_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
    "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
    "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP"
] as const;

export const FUNDING_SOURCES = ["employment_income", "investments", "inheritance", "business_income", "savings", "family"] as const;
export const EMPLOYMENT_STATUSES = ["employed", "unemployed", "student", "retired"] as const;
export const EXPERIENCE_LEVELS = ["none", "1_to_5_years", "over_5_years"] as const;
export const AGREEMENTS = ["customer_agreement", "account_agreement", "margin_agreement", "options_agreement"] as const;
export type FundingSource = typeof FUNDING_SOURCES[number];
export type EmploymentStatus = typeof EMPLOYMENT_STATUSES[number];
export type ExperienceLevel = typeof EXPERIENCE_LEVELS[number];
export type AgreementName = typeof AGREEMENTS[number];

// The application as the form builds it, in Alpaca's field names. The server adds each agreement's signed_at and ip_address.
export interface AccountApplication {
    contact: {
        email_address: string;
        phone_number: string;
        street_address: string[];
        unit?: string;
        city: string;
        state: string;
        postal_code: string;
        country: "USA";
    };
    identity: {
        given_name: string;
        middle_name?: string;
        family_name: string;
        date_of_birth: string;
        tax_id: string;
        tax_id_type: "USA_SSN" | "USA_ITIN";
        country_of_citizenship: string;
        country_of_birth?: string;
        country_of_tax_residence: "USA";
        permanent_resident?: boolean;
        funding_source: FundingSource[];
        annual_income_min?: string;
        annual_income_max?: string;
        liquid_net_worth_min?: string;
        liquid_net_worth_max?: string;
        total_net_worth_min?: string;
        total_net_worth_max?: string;
        investment_experience_with_stocks?: ExperienceLevel;
        investment_experience_with_options?: ExperienceLevel;
    };
    disclosures: {
        is_control_person: boolean;
        is_affiliated_exchange_or_finra: boolean;
        is_politically_exposed: boolean;
        immediate_family_exposed: boolean;
        employment_status?: EmploymentStatus;
        employer_name?: string;
        employer_address?: string;
        employment_position?: string;
        context?: {
            context_type: "CONTROLLED_FIRM" | "AFFILIATE_FIRM" | "IMMEDIATE_FAMILY_EXPOSED";
            company_name?: string;
            company_street_address?: string;
            company_city?: string;
            company_state?: string;
            company_country?: string;
            company_compliance_email?: string;
            given_name?: string;
            family_name?: string;
        }[];
    };
    trusted_contact?: {
        given_name: string;
        family_name: string;
        email_address?: string;
        phone_number?: string;
    };
    // Which agreements the applicant accepted; customer and account agreements are required, margin opens a margin account and
    // options asks for options trading
    agreements: AgreementName[];
    // The options level asked for with the options agreement (1 to 3)
    options_level?: number;
    // The W-9 certification: the tax ID is correct, the applicant is a U.S. person, and whether they're subject to backup withholding
    w9: { certified: boolean; backup_withholding: boolean };
    // That Form CRS and the privacy notice were shown
    disclosures_delivered: { form_crs: boolean; privacy_notice: boolean };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;
const digits = (value: string) => value.replace(/\D/g, "");

// Whether a 9-digit SSN can be valid: no 000, 666 or 900-999 area, no 00 group, no 0000 serial
export const isValidSsn = (value: string): boolean => {
    const ssn = digits(value);
    if (ssn.length !== 9) return false;
    const area = Number(ssn.slice(0, 3));
    return area !== 0 && area !== 666 && area < 900 && ssn.slice(3, 5) !== "00" && ssn.slice(5) !== "0000";
};

// Whether a 9-digit ITIN can be valid: starts with 9, with a middle group of 50-65, 70-88, 90-92 or 94-99
export const isValidItin = (value: string): boolean => {
    const itin = digits(value);
    if (itin.length !== 9 || itin[0] !== "9") return false;
    const group = Number(itin.slice(3, 5));
    return (group >= 50 && group <= 65) || (group >= 70 && group <= 88) || (group >= 90 && group <= 92) || group >= 94;
};

// The tax ID as stored and shown: only its last 4 digits ("XXX-XX-1234")
export const maskTaxId = (value: string): string => `XXX-XX-${digits(value).slice(-4).padStart(4, "X")}`;

// Age in whole years on today ("YYYY-MM-DD")
export const ageOn = (dateOfBirth: string, today: string): number => {
    const [y, m, d] = dateOfBirth.split("-").map(Number);
    const [ty, tm, td] = today.split("-").map(Number);
    return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Every problem with an application, by field path (empty when it can be submitted). today is "YYYY-MM-DD".
export const validateApplication = (application: AccountApplication, today: string): Record<string, string> => {
    const errors: Record<string, string> = {};
    const { contact, identity, disclosures, trusted_contact: trusted, agreements, w9 } = application;
    const required = (path: string, value: string | undefined, label: string) => {
        if (!value?.trim()) errors[path] = `${label} is required`;
    };

    required("contact.email_address", contact.email_address, "Email");
    if (contact.email_address && !EMAIL.test(contact.email_address)) errors["contact.email_address"] = "Enter a valid email address";
    const phone = digits(contact.phone_number ?? "");
    if (phone.length !== 10 && !(phone.length === 11 && phone.startsWith("1"))) errors["contact.phone_number"] = "Enter a 10-digit U.S. phone number";
    const lines = contact.street_address.filter(line => line.trim());
    if (lines.length === 0) errors["contact.street_address"] = "Street address is required";
    else if (lines.length > 3) errors["contact.street_address"] = "At most 3 address lines";
    else if (lines.some(line => PO_BOX.test(line))) errors["contact.street_address"] = "A residential address is required, not a P.O. box";
    required("contact.city", contact.city, "City");
    if (!(US_STATES as readonly string[]).includes(contact.state)) errors["contact.state"] = "Choose a state";
    if (!/^\d{5}(-?\d{4})?$/.test(contact.postal_code.trim())) errors["contact.postal_code"] = "Enter a 5-digit ZIP code";
    if (contact.country !== "USA") errors["contact.country"] = "Only U.S. addresses are accepted";

    required("identity.given_name", identity.given_name, "First name");
    required("identity.family_name", identity.family_name, "Last name");
    if (!isDate(identity.date_of_birth)) errors["identity.date_of_birth"] = "Enter your date of birth";
    else if (ageOn(identity.date_of_birth, today) < 18) errors["identity.date_of_birth"] = "You must be at least 18";
    else if (ageOn(identity.date_of_birth, today) > 120) errors["identity.date_of_birth"] = "Check your date of birth";
    if (identity.tax_id_type === "USA_SSN" ? !isValidSsn(identity.tax_id) : !isValidItin(identity.tax_id)) {
        errors["identity.tax_id"] = identity.tax_id_type === "USA_SSN" ? "Enter a valid Social Security number" : "Enter a valid ITIN";
    }
    if (identity.country_of_tax_residence !== "USA") errors["identity.country_of_tax_residence"] = "Only U.S. tax residents are accepted";
    if (identity.country_of_citizenship !== "USA" && !identity.permanent_resident) {
        errors["identity.country_of_citizenship"] = "Only U.S. citizens and permanent residents are accepted";
    }
    if (identity.funding_source.length === 0 || identity.funding_source.some(source => !FUNDING_SOURCES.includes(source))) {
        errors["identity.funding_source"] = "Choose at least one source of funds";
    }
    const range = (minKey: "annual_income_min" | "liquid_net_worth_min" | "total_net_worth_min", maxKey: "annual_income_max" | "liquid_net_worth_max" | "total_net_worth_max") => {
        const min = identity[minKey], max = identity[maxKey];
        if (min !== undefined && max !== undefined && Number(max) < Number(min)) errors[`identity.${minKey}`] = "The range's maximum is below its minimum";
    };
    range("annual_income_min", "annual_income_max");
    range("liquid_net_worth_min", "liquid_net_worth_max");
    range("total_net_worth_min", "total_net_worth_max");

    if (!disclosures.employment_status || !EMPLOYMENT_STATUSES.includes(disclosures.employment_status)) {
        errors["disclosures.employment_status"] = "Choose your employment status";
    } else if (disclosures.employment_status === "employed") {
        required("disclosures.employer_name", disclosures.employer_name, "Employer");
        required("disclosures.employment_position", disclosures.employment_position, "Position");
    }
    const contexts = disclosures.context ?? [];
    const firm = (type: "CONTROLLED_FIRM" | "AFFILIATE_FIRM", flag: boolean, path: string) => {
        if (!flag) return;
        const context = contexts.find(({ context_type }) => context_type === type);
        if (!context?.company_name?.trim() || !context.company_street_address?.trim() || !context.company_city?.trim() || !context.company_country?.trim()
            || !EMAIL.test(context.company_compliance_email ?? "")) {
            errors[path] = "Give the company's name, address and compliance email";
        }
    };
    firm("CONTROLLED_FIRM", disclosures.is_control_person, "disclosures.is_control_person");
    firm("AFFILIATE_FIRM", disclosures.is_affiliated_exchange_or_finra, "disclosures.is_affiliated_exchange_or_finra");
    if (disclosures.immediate_family_exposed) {
        const family = contexts.find(({ context_type }) => context_type === "IMMEDIATE_FAMILY_EXPOSED");
        if (!family?.given_name?.trim() || !family.family_name?.trim()) errors["disclosures.immediate_family_exposed"] = "Give the family member's name";
    }

    if (trusted && (trusted.given_name || trusted.family_name || trusted.email_address || trusted.phone_number)) {
        required("trusted_contact.given_name", trusted.given_name, "The trusted contact's first name");
        required("trusted_contact.family_name", trusted.family_name, "The trusted contact's last name");
        if (!trusted.email_address && !trusted.phone_number) errors["trusted_contact.email_address"] = "Give the trusted contact's email or phone";
        else if (trusted.email_address && !EMAIL.test(trusted.email_address)) errors["trusted_contact.email_address"] = "Enter a valid email address";
    }

    if (!agreements.includes("customer_agreement") || !agreements.includes("account_agreement")) {
        errors.agreements = "Accept the customer and account agreements";
    }
    if (agreements.includes("options_agreement")) {
        if (!application.options_level || application.options_level < 1 || application.options_level > 3) errors.options_level = "Choose an options level";
        if (!identity.investment_experience_with_options) errors["identity.investment_experience_with_options"] = "Options trading needs your options experience";
    }
    if (!w9.certified) errors.w9 = "Certify your taxpayer information (Form W-9)";
    if (!application.disclosures_delivered.form_crs || !application.disclosures_delivered.privacy_notice) {
        errors.disclosures_delivered = "Confirm you've received Form CRS and the privacy notice";
    }
    return errors;
};
