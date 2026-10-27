"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import axios from "axios";
import { useUser } from "@clerk/nextjs";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { EXPERIENCE_LEVELS, FUNDING_SOURCES, US_STATES, validateApplication, type AccountApplication, type AgreementName, type ExperienceLevel, type FundingSource } from "@/lib/kyc";
import { easternParts } from "@/lib/marketHours";
import type { OpenAccountRequest } from "@/lib/types";

const STEPS = ["Account", "Contact", "Identity", "Employment", "Finances", "Trusted contact", "Review"] as const;
// Which fields each step shows, by the prefix of validateApplication's error paths
const STEP_FIELDS: string[][] = [
    ["options_level"],
    ["contact."],
    ["identity.given_name", "identity.family_name", "identity.date_of_birth", "identity.tax_id", "identity.country_of"],
    ["disclosures."],
    ["identity.funding_source", "identity.annual_income", "identity.liquid_net_worth", "identity.total_net_worth", "identity.investment_experience"],
    ["trusted_contact."],
    ["agreements", "w9", "disclosures_delivered"]
];

// Income and net worth as Alpaca's min/max pairs; the top range has no maximum
const RANGES: { label: string; min: string; max?: string }[] = [
    { label: "Under $25,000", min: "0", max: "24999" },
    { label: "$25,000 – $49,999", min: "25000", max: "49999" },
    { label: "$50,000 – $99,999", min: "50000", max: "99999" },
    { label: "$100,000 – $249,999", min: "100000", max: "249999" },
    { label: "$250,000 – $999,999", min: "250000", max: "999999" },
    { label: "$1,000,000 or more", min: "1000000" }
];
const FUNDING_LABELS: Record<FundingSource, string> = {
    employment_income: "Employment income", investments: "Investments", inheritance: "Inheritance", business_income: "Business income", savings: "Savings", family: "Family"
};
const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = { none: "None", "1_to_5_years": "1 to 5 years", over_5_years: "Over 5 years" };
const OPTIONS_LEVELS = [
    { level: 1, label: "Level 1: covered calls and cash-secured puts" },
    { level: 2, label: "Level 2: also buying calls and puts" },
    { level: 3, label: "Level 3: also spreads" }
];

const emptyApplication = (email: string): AccountApplication => ({
    contact: { email_address: email, phone_number: "", street_address: ["", ""], unit: "", city: "", state: "", postal_code: "", country: "USA" },
    identity: {
        given_name: "", middle_name: "", family_name: "", date_of_birth: "", tax_id: "", tax_id_type: "USA_SSN", country_of_citizenship: "USA",
        country_of_tax_residence: "USA", permanent_resident: false, funding_source: []
    },
    disclosures: { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false, employment_status: undefined, context: [] },
    trusted_contact: { given_name: "", family_name: "", email_address: "", phone_number: "" },
    agreements: [],
    w9: { certified: false, backup_withholding: false },
    disclosures_delivered: { form_crs: false, privacy_notice: false }
});

type Context = NonNullable<AccountApplication["disclosures"]["context"]>[number];

const Field = ({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) => (
    <label className="transfer-field">
        <span className="transfer-field-label">{label}</span>
        {children}
        {hint && <small className="text-muted">{hint}</small>}
        {error && <small className="text-danger">{error}</small>}
    </label>
);

// The account application: the account type, contact details, identity and tax ID, employment and the regulatory disclosures,
// finances and experience, an optional trusted contact, then the agreements, the W-9 certification and the delivered disclosures.
// Each step is checked with lib/kyc.ts's validateApplication before moving on; the server checks it all again.
const OnboardingWizard = ({ onSubmitted }: { onSubmitted: () => Promise<void> }) => {
    const { user } = useUser();
    const [application, setApplication] = useState<AccountApplication>(() => emptyApplication(user?.primaryEmailAddress?.emailAddress ?? ""));
    const [margin, setMargin] = useState(false);
    const [options, setOptions] = useState(false);
    const [step, setStep] = useState(0);
    const [showErrors, setShowErrors] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    // The application as submitted: the chosen account type's agreements are added to the two everyone signs on the review step
    const withAccountType = (base: AccountApplication): AccountApplication => {
        const signed = base.agreements.filter(agreement => agreement === "customer_agreement" || agreement === "account_agreement");
        const agreements: AgreementName[] = [...signed, ...(margin && base.agreements.includes("margin_agreement") ? ["margin_agreement" as const] : []),
            ...(options && base.agreements.includes("options_agreement") ? ["options_agreement" as const] : [])];
        return { ...base, agreements, options_level: options ? base.options_level : undefined };
    };
    const allErrors = validateApplication(withAccountType(application), easternParts(new Date()).dateKey);
    const accountTypeErrors: Record<string, string> = {};
    if (options && !application.options_level) accountTypeErrors.options_level = "Choose an options level";
    if (options && !application.identity.investment_experience_with_options) accountTypeErrors["identity.investment_experience_with_options"] = "Options trading needs your options experience";
    if (step === 6 && margin && !application.agreements.includes("margin_agreement")) accountTypeErrors.agreements = "Accept the margin agreement, or go back and choose a cash account";
    if (step === 6 && options && !application.agreements.includes("options_agreement")) accountTypeErrors.agreements = "Accept the options agreement, or go back and drop options";
    const errors = { ...allErrors, ...accountTypeErrors };
    const stepErrors = (index: number) => Object.keys(errors).filter(path => STEP_FIELDS[index].some(prefix => path.startsWith(prefix)));
    const error = (path: string) => showErrors ? errors[path] : undefined;

    const set = <K extends keyof AccountApplication>(section: K, changes: Partial<AccountApplication[K]>) =>
        setApplication(previous => ({ ...previous, [section]: { ...(previous[section] as object), ...changes } }));
    const toggleAgreement = (agreement: AgreementName, accepted: boolean) =>
        setApplication(previous => ({ ...previous, agreements: accepted ? [...new Set([...previous.agreements, agreement])] : previous.agreements.filter(name => name !== agreement) }));
    const setContext = (type: Context["context_type"], changes: Partial<Context> | null) => setApplication(previous => {
        const others = (previous.disclosures.context ?? []).filter(({ context_type }) => context_type !== type);
        const current = (previous.disclosures.context ?? []).find(({ context_type }) => context_type === type) ?? { context_type: type };
        return { ...previous, disclosures: { ...previous.disclosures, context: changes === null ? others : [...others, { ...current, ...changes }] } };
    });
    const context = (type: Context["context_type"]) => application.disclosures.context?.find(({ context_type }) => context_type === type) ?? { context_type: type };
    const setRange = (prefix: "annual_income" | "liquid_net_worth" | "total_net_worth", index: string) => {
        const range = RANGES[Number(index)];
        set("identity", { [`${prefix}_min`]: range?.min, [`${prefix}_max`]: range?.max } as Partial<AccountApplication["identity"]>);
    };
    const rangeIndex = (prefix: "annual_income" | "liquid_net_worth" | "total_net_worth") => String(RANGES.findIndex(({ min }) => min === application.identity[`${prefix}_min`]));

    const next = () => {
        if (stepErrors(step).length > 0) {
            setShowErrors(true);
            return;
        }
        setShowErrors(false);
        setStep(step + 1);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (step < STEPS.length - 1) return next();
        if (Object.keys(errors).length > 0) {
            setShowErrors(true);
            const firstStep = STEP_FIELDS.findIndex((_, index) => stepErrors(index).length > 0);
            if (firstStep >= 0 && firstStep < step) setStep(firstStep);
            return;
        }
        setSubmitting(true);
        setSubmitError(null);
        try {
            const submitted = withAccountType(application);
            const trusted = submitted.trusted_contact;
            await axios.post("/api/accounts", {
                application: { ...submitted, trusted_contact: trusted?.given_name || trusted?.family_name ? trusted : undefined }
            } satisfies OpenAccountRequest);
            await onSubmitted();
        } catch (error) {
            logError(error);
            setSubmitError(apiErrorMessage(error));
        } finally {
            setSubmitting(false);
        }
    };

    const { contact, identity, disclosures, trusted_contact: trusted } = application;
    const disclosure = (flag: "is_control_person" | "is_affiliated_exchange_or_finra" | "is_politically_exposed" | "immediate_family_exposed", label: string, contextType: Context["context_type"] | null) => (
        <div className="onboarding-disclosure">
            <label className="onboarding-check">
                <input type="checkbox" checked={disclosures[flag]} onChange={event => {
                    set("disclosures", { [flag]: event.target.checked });
                    if (contextType && !event.target.checked) setContext(contextType, null);
                }} />
                {label}
            </label>
            {error(`disclosures.${flag}`) && <small className="text-danger">{error(`disclosures.${flag}`)}</small>}
            {disclosures[flag] && contextType && contextType !== "IMMEDIATE_FAMILY_EXPOSED" && (
                <div className="transfer-fields onboarding-indent">
                    <input className="form-control" placeholder="Company name" value={context(contextType).company_name ?? ""} onChange={event => setContext(contextType, { company_name: event.target.value })} />
                    <input className="form-control" placeholder="Company street address" value={context(contextType).company_street_address ?? ""} onChange={event => setContext(contextType, { company_street_address: event.target.value })} />
                    <div className="transfer-row">
                        <input className="form-control" placeholder="City" value={context(contextType).company_city ?? ""} onChange={event => setContext(contextType, { company_city: event.target.value })} />
                        <input className="form-control" placeholder="State" value={context(contextType).company_state ?? ""} onChange={event => setContext(contextType, { company_state: event.target.value })} />
                        <input className="form-control" placeholder="Country" value={context(contextType).company_country ?? ""} onChange={event => setContext(contextType, { company_country: event.target.value })} />
                    </div>
                    <input className="form-control" type="email" placeholder="Compliance department email" value={context(contextType).company_compliance_email ?? ""} onChange={event => setContext(contextType, { company_compliance_email: event.target.value })} />
                </div>
            )}
            {disclosures[flag] && contextType === "IMMEDIATE_FAMILY_EXPOSED" && (
                <div className="transfer-row onboarding-indent">
                    <input className="form-control" placeholder="Family member's first name" value={context(contextType).given_name ?? ""} onChange={event => setContext(contextType, { given_name: event.target.value })} />
                    <input className="form-control" placeholder="Last name" value={context(contextType).family_name ?? ""} onChange={event => setContext(contextType, { family_name: event.target.value })} />
                </div>
            )}
        </div>
    );

    return (
        <form className="transfer-container onboarding mt-5" onSubmit={submit} noValidate>
            <h1 className="transfer-title">Open your account</h1>
            <ol className="onboarding-steps" aria-label="Steps">
                {STEPS.map((name, index) => <li key={name} className={index === step ? "active" : index < step ? "done" : ""}>{name}</li>)}
            </ol>
            <p className="onboarding-test-note">
                This is a simulator. Enter made-up test details, not your real ones: only the last 4 digits of the tax ID are kept. Last names
                &quot;Review&quot;, &quot;ActionRequired&quot; and &quot;Reject&quot; try the other review outcomes.
            </p>

            {step === 0 && (
                <div className="transfer-fields">
                    <div className="method-tiles" role="radiogroup" aria-label="Account type">
                        <button type="button" role="radio" aria-checked={!margin} className={`method-tile${!margin ? " active" : ""}`} onClick={() => setMargin(false)}>Cash account</button>
                        <button type="button" role="radio" aria-checked={margin} className={`method-tile${margin ? " active" : ""}`} onClick={() => setMargin(true)}>Margin account</button>
                    </div>
                    <p className="text-muted">
                        {margin
                            ? "A margin account can borrow against its stocks (up to 2× overnight) and sell short, once it holds at least $2,000. Borrowing costs interest, and losses can exceed what you deposit."
                            : "A cash account buys with the money in it, never borrowed. It can't sell short. You can upgrade to margin later in Settings."}
                    </p>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={options} onChange={event => setOptions(event.target.checked)} />
                        Also apply for options trading
                    </label>
                    {options && (
                        <Field label="Options level" error={error("options_level")}>
                            <select className="form-control" value={application.options_level ?? ""} onChange={event => setApplication({ ...application, options_level: Number(event.target.value) || undefined })}>
                                <option value="">Choose…</option>
                                {OPTIONS_LEVELS.map(({ level, label }) => <option key={level} value={level}>{label}</option>)}
                            </select>
                        </Field>
                    )}
                </div>
            )}

            {step === 1 && (
                <div className="transfer-fields">
                    <Field label="Email" error={error("contact.email_address")}>
                        <input className="form-control" type="email" autoComplete="email" value={contact.email_address} onChange={event => set("contact", { email_address: event.target.value })} />
                    </Field>
                    <Field label="Phone" error={error("contact.phone_number")}>
                        <input className="form-control" type="tel" autoComplete="tel" placeholder="(555) 555-0100" value={contact.phone_number} onChange={event => set("contact", { phone_number: event.target.value })} />
                    </Field>
                    <Field label="Home address" error={error("contact.street_address")} hint="Where you live; a P.O. box isn't accepted">
                        <input className="form-control" autoComplete="address-line1" placeholder="Street address" value={contact.street_address[0]} onChange={event => set("contact", { street_address: [event.target.value, contact.street_address[1] ?? ""] })} />
                        <input className="form-control mt-2" autoComplete="address-line2" placeholder="Apartment, suite (optional)" value={contact.street_address[1] ?? ""} onChange={event => set("contact", { street_address: [contact.street_address[0], event.target.value] })} />
                    </Field>
                    <div className="transfer-row">
                        <Field label="City" error={error("contact.city")}>
                            <input className="form-control" autoComplete="address-level2" value={contact.city} onChange={event => set("contact", { city: event.target.value })} />
                        </Field>
                        <Field label="State" error={error("contact.state")}>
                            <select className="form-control" autoComplete="address-level1" value={contact.state} onChange={event => set("contact", { state: event.target.value })}>
                                <option value="">—</option>
                                {US_STATES.map(state => <option key={state}>{state}</option>)}
                            </select>
                        </Field>
                        <Field label="ZIP" error={error("contact.postal_code")}>
                            <input className="form-control" autoComplete="postal-code" inputMode="numeric" value={contact.postal_code} onChange={event => set("contact", { postal_code: event.target.value })} />
                        </Field>
                    </div>
                </div>
            )}

            {step === 2 && (
                <div className="transfer-fields">
                    <div className="transfer-row">
                        <Field label="First name" error={error("identity.given_name")}>
                            <input className="form-control" autoComplete="given-name" value={identity.given_name} onChange={event => set("identity", { given_name: event.target.value })} />
                        </Field>
                        <Field label="Middle name">
                            <input className="form-control" autoComplete="additional-name" value={identity.middle_name ?? ""} onChange={event => set("identity", { middle_name: event.target.value })} />
                        </Field>
                    </div>
                    <Field label="Last name" error={error("identity.family_name")}>
                        <input className="form-control" autoComplete="family-name" value={identity.family_name} onChange={event => set("identity", { family_name: event.target.value })} />
                    </Field>
                    <Field label="Date of birth" error={error("identity.date_of_birth")}>
                        <input className="form-control" type="date" value={identity.date_of_birth} onChange={event => set("identity", { date_of_birth: event.target.value })} />
                    </Field>
                    <div className="transfer-row">
                        <Field label="Tax ID type">
                            <select className="form-control" value={identity.tax_id_type} onChange={event => set("identity", { tax_id_type: event.target.value as "USA_SSN" | "USA_ITIN" })}>
                                <option value="USA_SSN">Social Security number</option>
                                <option value="USA_ITIN">ITIN</option>
                            </select>
                        </Field>
                        <Field label={identity.tax_id_type === "USA_SSN" ? "SSN" : "ITIN"} error={error("identity.tax_id")} hint="Only the last 4 digits are kept">
                            <input className="form-control" type="password" autoComplete="off" inputMode="numeric" placeholder="123-45-6789" value={identity.tax_id} onChange={event => set("identity", { tax_id: event.target.value })} />
                        </Field>
                    </div>
                    <Field label="Citizenship" error={error("identity.country_of_citizenship")}>
                        <select className="form-control" value={identity.country_of_citizenship === "USA" ? "USA" : "OTHER"} onChange={event => set("identity", { country_of_citizenship: event.target.value === "USA" ? "USA" : "", permanent_resident: event.target.value === "USA" ? false : identity.permanent_resident })}>
                            <option value="USA">U.S. citizen</option>
                            <option value="OTHER">Another country</option>
                        </select>
                    </Field>
                    {identity.country_of_citizenship !== "USA" && (
                        <div className="transfer-fields onboarding-indent">
                            <Field label="Country of citizenship (3-letter code, such as MEX)">
                                <input className="form-control" maxLength={3} value={identity.country_of_citizenship} onChange={event => set("identity", { country_of_citizenship: event.target.value.toUpperCase() })} />
                            </Field>
                            <label className="onboarding-check">
                                <input type="checkbox" checked={identity.permanent_resident ?? false} onChange={event => set("identity", { permanent_resident: event.target.checked })} />
                                I&apos;m a U.S. permanent resident (green card holder)
                            </label>
                        </div>
                    )}
                    <p className="text-muted">Accounts are for U.S. tax residents with a U.S. address.</p>
                </div>
            )}

            {step === 3 && (
                <div className="transfer-fields">
                    <Field label="Employment status" error={error("disclosures.employment_status")}>
                        <select className="form-control" value={disclosures.employment_status ?? ""} onChange={event => set("disclosures", { employment_status: (event.target.value || undefined) as AccountApplication["disclosures"]["employment_status"] })}>
                            <option value="">Choose…</option>
                            <option value="employed">Employed</option>
                            <option value="unemployed">Unemployed</option>
                            <option value="student">Student</option>
                            <option value="retired">Retired</option>
                        </select>
                    </Field>
                    {disclosures.employment_status === "employed" && (
                        <div className="transfer-fields onboarding-indent">
                            <Field label="Employer" error={error("disclosures.employer_name")}>
                                <input className="form-control" autoComplete="organization" value={disclosures.employer_name ?? ""} onChange={event => set("disclosures", { employer_name: event.target.value })} />
                            </Field>
                            <Field label="Employer's address">
                                <input className="form-control" value={disclosures.employer_address ?? ""} onChange={event => set("disclosures", { employer_address: event.target.value })} />
                            </Field>
                            <Field label="Position" error={error("disclosures.employment_position")}>
                                <input className="form-control" autoComplete="organization-title" value={disclosures.employment_position ?? ""} onChange={event => set("disclosures", { employment_position: event.target.value })} />
                            </Field>
                        </div>
                    )}
                    <p className="transfer-field-label mb-0">Do any of these apply to you?</p>
                    {disclosure("is_control_person", "I'm a director, 10% shareholder or senior officer of a publicly traded company", "CONTROLLED_FIRM")}
                    {disclosure("is_affiliated_exchange_or_finra", "I work for (or am a family member of someone who works for) a stock exchange or a FINRA member firm", "AFFILIATE_FIRM")}
                    {disclosure("is_politically_exposed", "I'm a senior political figure, or a close associate of one", null)}
                    {disclosure("immediate_family_exposed", "A member of my immediate family is a senior political figure", "IMMEDIATE_FAMILY_EXPOSED")}
                </div>
            )}

            {step === 4 && (
                <div className="transfer-fields">
                    <Field label="Annual income" error={error("identity.annual_income_min")}>
                        <select className="form-control" value={rangeIndex("annual_income")} onChange={event => setRange("annual_income", event.target.value)}>
                            <option value="-1">Choose…</option>
                            {RANGES.map(({ label }, index) => <option key={label} value={index}>{label}</option>)}
                        </select>
                    </Field>
                    <Field label="Liquid net worth" hint="Cash and investments you could sell quickly" error={error("identity.liquid_net_worth_min")}>
                        <select className="form-control" value={rangeIndex("liquid_net_worth")} onChange={event => setRange("liquid_net_worth", event.target.value)}>
                            <option value="-1">Choose…</option>
                            {RANGES.map(({ label }, index) => <option key={label} value={index}>{label}</option>)}
                        </select>
                    </Field>
                    <Field label="Total net worth" error={error("identity.total_net_worth_min")}>
                        <select className="form-control" value={rangeIndex("total_net_worth")} onChange={event => setRange("total_net_worth", event.target.value)}>
                            <option value="-1">Choose…</option>
                            {RANGES.map(({ label }, index) => <option key={label} value={index}>{label}</option>)}
                        </select>
                    </Field>
                    <fieldset className="transfer-field">
                        <legend className="transfer-field-label">Where does the money you&apos;ll invest come from?</legend>
                        <div className="onboarding-options">
                            {FUNDING_SOURCES.map(source => (
                                <label key={source} className="onboarding-check">
                                    <input type="checkbox" checked={identity.funding_source.includes(source)} onChange={event => set("identity", {
                                        funding_source: event.target.checked ? [...identity.funding_source, source] : identity.funding_source.filter(other => other !== source)
                                    })} />
                                    {FUNDING_LABELS[source]}
                                </label>
                            ))}
                        </div>
                        {error("identity.funding_source") && <small className="text-danger">{error("identity.funding_source")}</small>}
                    </fieldset>
                    <Field label="Experience investing in stocks">
                        <select className="form-control" value={identity.investment_experience_with_stocks ?? ""} onChange={event => set("identity", { investment_experience_with_stocks: (event.target.value || undefined) as ExperienceLevel | undefined })}>
                            <option value="">Choose…</option>
                            {EXPERIENCE_LEVELS.map(level => <option key={level} value={level}>{EXPERIENCE_LABELS[level]}</option>)}
                        </select>
                    </Field>
                    {options && (
                        <Field label="Experience trading options" error={error("identity.investment_experience_with_options")}>
                            <select className="form-control" value={identity.investment_experience_with_options ?? ""} onChange={event => set("identity", { investment_experience_with_options: (event.target.value || undefined) as ExperienceLevel | undefined })}>
                                <option value="">Choose…</option>
                                {EXPERIENCE_LEVELS.map(level => <option key={level} value={level}>{EXPERIENCE_LABELS[level]}</option>)}
                            </select>
                        </Field>
                    )}
                </div>
            )}

            {step === 5 && trusted && (
                <div className="transfer-fields">
                    <p className="text-muted">
                        Optional. A trusted contact is someone we may reach if we can&apos;t reach you, or suspect financial exploitation. They can&apos;t see or act on your account.
                    </p>
                    <div className="transfer-row">
                        <Field label="First name" error={error("trusted_contact.given_name")}>
                            <input className="form-control" value={trusted.given_name} onChange={event => set("trusted_contact", { given_name: event.target.value })} />
                        </Field>
                        <Field label="Last name" error={error("trusted_contact.family_name")}>
                            <input className="form-control" value={trusted.family_name} onChange={event => set("trusted_contact", { family_name: event.target.value })} />
                        </Field>
                    </div>
                    <Field label="Email" error={error("trusted_contact.email_address")}>
                        <input className="form-control" type="email" value={trusted.email_address ?? ""} onChange={event => set("trusted_contact", { email_address: event.target.value })} />
                    </Field>
                    <Field label="Phone">
                        <input className="form-control" type="tel" value={trusted.phone_number ?? ""} onChange={event => set("trusted_contact", { phone_number: event.target.value })} />
                    </Field>
                </div>
            )}

            {step === 6 && (
                <div className="transfer-fields">
                    <dl className="onboarding-review">
                        <dt>Account</dt><dd>{margin ? "Margin" : "Cash"} account{options && application.options_level ? `, options level ${application.options_level}` : ""}</dd>
                        <dt>Name</dt><dd>{[identity.given_name, identity.middle_name, identity.family_name].filter(Boolean).join(" ")}</dd>
                        <dt>Address</dt><dd>{[...contact.street_address.filter(Boolean), `${contact.city}, ${contact.state} ${contact.postal_code}`].join(", ")}</dd>
                        <dt>Tax ID</dt><dd>•••-••-{identity.tax_id.replace(/\D/g, "").slice(-4)}</dd>
                    </dl>
                    <p className="transfer-field-label mb-0">Agreements</p>
                    {([
                        ["customer_agreement", "Customer agreement"],
                        ["account_agreement", "Account agreement"],
                        ...(margin ? [["margin_agreement", "Margin agreement"]] : []),
                        ...(options ? [["options_agreement", "Options agreement"]] : [])
                    ] as [AgreementName, string][]).map(([agreement, label]) => (
                        <label key={agreement} className="onboarding-check">
                            <input type="checkbox" checked={application.agreements.includes(agreement)} onChange={event => toggleAgreement(agreement, event.target.checked)} />
                            I&apos;ve read and accept the <Link href={`/agreements/${agreement}`} target="_blank">{label.toLowerCase()}</Link>
                        </label>
                    ))}
                    {error("agreements") && <small className="text-danger">{error("agreements")}</small>}
                    <p className="transfer-field-label mb-0">Taxpayer certification (Form W-9)</p>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={application.w9.certified} onChange={event => set("w9", { certified: event.target.checked })} />
                        Under penalties of perjury, I certify that the tax ID I gave is correct, that I&apos;m a U.S. citizen or other U.S. person, and that I&apos;m not subject to backup withholding unless I check the box below
                    </label>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={application.w9.backup_withholding} onChange={event => set("w9", { backup_withholding: event.target.checked })} />
                        The IRS has told me I&apos;m subject to backup withholding (24% is then withheld from dividends and sale proceeds)
                    </label>
                    {error("w9") && <small className="text-danger">{error("w9")}</small>}
                    <label className="onboarding-check">
                        <input type="checkbox" checked={application.disclosures_delivered.form_crs && application.disclosures_delivered.privacy_notice}
                            onChange={event => set("disclosures_delivered", { form_crs: event.target.checked, privacy_notice: event.target.checked })} />
                        I&apos;ve received the <Link href="/agreements/form_crs" target="_blank">relationship summary (Form CRS)</Link> and the <Link href="/agreements/privacy_notice" target="_blank">privacy notice</Link>
                    </label>
                    {error("disclosures_delivered") && <small className="text-danger">{error("disclosures_delivered")}</small>}
                    {submitError && <p className="text-danger">{submitError}</p>}
                </div>
            )}

            <div className="onboarding-buttons">
                {step > 0 && <button type="button" className="btn btn-outline-dark" onClick={() => { setShowErrors(false); setStep(step - 1); }}>Back</button>}
                <button type="submit" className="btn btn-dark" disabled={submitting}>
                    {step < STEPS.length - 1 ? (step === 5 && !trusted?.given_name ? "Skip" : "Continue") : submitting ? "Submitting…" : "Submit application"}
                </button>
            </div>
        </form>
    );
};

export default OnboardingWizard;
