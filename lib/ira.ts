// IRAs (traditional and Roth) as Alpaca's Broker API offers them (docs.alpaca.markets/docs/ira-accounts-overview), with the IRS's
// contribution limits and distribution codes. Shared by the server and the pages; pure, so it can be unit tested.
//   Contributions are deposits, each for a tax year: the current one, or the previous one until its April 15 deadline. The limit is
//   per person across all their IRAs (traditional and Roth together), with a catch-up from the year they turn 50. Alpaca only checks the
//   limit by age (income and filing status lower it for Roth contributions; the customer is responsible for those).
//   Distributions are withdrawals with a reason (the IRS needs one; it gives the 1099-R's code) and tax withholding: 10% federal unless
//   the customer opts out, and state withholding as elected, taken from the amount requested.

export type IraSubType = "traditional" | "roth";

export const IRA_LABELS: Record<IraSubType, string> = { traditional: "Traditional IRA", roth: "Roth IRA" };

// IRAs trade at 1x (no margin borrowing, no shorting) and options up to level 2 (covered calls, cash-secured puts, buying calls and puts)
export const IRA_MAX_OPTIONS_LEVEL = 2;

// The IRS's limits per tax year (IRS Notice 2024-80 for 2025; Notice 2025-67, IR-2025-111, for 2026: $7,500 and a $1,100 catch-up). A
// later year uses the newest one known until it's added here.
export const IRA_LIMITS: Record<number, { base: number; catchUp: number }> = {
    2024: { base: 7000, catchUp: 1000 },
    2025: { base: 7000, catchUp: 1000 },
    2026: { base: 7500, catchUp: 1100 }
};

const limitsFor = (taxYear: number) => {
    const known = Object.keys(IRA_LIMITS).map(Number).sort((a, b) => a - b);
    return IRA_LIMITS[taxYear] ?? IRA_LIMITS[known.filter(year => year <= taxYear).at(-1) ?? known[0]];
};

// Whole years of age on a day ("YYYY-MM-DD" both)
export const ageOn = (dateOfBirth: string, day: string): number => {
    const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
    const [year, month, date] = day.split("-").map(Number);
    return year - birthYear - (month < birthMonth || (month === birthMonth && date < birthDay) ? 1 : 0);
};

// Whether someone is 59½ on a day: six months after their 59th birthday
export const reached59AndAHalf = (dateOfBirth: string, day: string): boolean => {
    const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
    const month = birthMonth + 6;
    const halfway = `${birthYear + 59 + (month > 12 ? 1 : 0)}-${String(month > 12 ? month - 12 : month).padStart(2, "0")}-${String(birthDay).padStart(2, "0")}`;
    return day >= halfway;
};

// The year's limit for someone: the base, plus the catch-up when they're 50 by the year's end
export const contributionLimit = (taxYear: number, dateOfBirth: string): number => {
    const { base, catchUp } = limitsFor(taxYear);
    return base + (ageOn(dateOfBirth, `${taxYear}-12-31`) >= 50 ? catchUp : 0);
};

// The prior year's contribution deadline: April 15 (the IRS moves it when the 15th is a weekend or holiday, which isn't modeled)
export const contributionDeadline = (taxYear: number) => `${taxYear + 1}-04-15`;

// The tax years a contribution made on day can be for, newest first
export const contributionTaxYears = (day: string): number[] => {
    const year = Number(day.slice(0, 4));
    return day <= contributionDeadline(year - 1) ? [year, year - 1] : [year];
};

// Why a contribution can't be made, or null: a tax year that's open, within what's left of the person's limit across their IRAs
export const contributionError = ({ amount, taxYear, day, dateOfBirth, contributed }: { amount: number; taxYear: number; day: string; dateOfBirth: string; contributed: number }): string | null => {
    if (!contributionTaxYears(day).includes(taxYear)) {
        return `contributions for ${taxYear} aren't accepted now: ${taxYear < Number(day.slice(0, 4)) ? `the deadline was ${contributionDeadline(taxYear)}` : "that year hasn't started"}`;
    }
    const limit = contributionLimit(taxYear, dateOfBirth);
    const left = Math.max(0, Math.round((limit - contributed) * 100) / 100);
    if (amount > left + 0.005) return `that would exceed the ${taxYear} IRA limit of $${limit.toLocaleString("en-US")} across your IRAs ($${left.toLocaleString("en-US", { minimumFractionDigits: 2 })} left)`;
    return null;
};

export interface DistributionReason {
    label: string;
    // The 1099-R's box 7 code
    code: string;
    subTypes: IraSubType[];
    // Who it's for: under or over 59½, or anyone
    age: "under" | "over" | "any";
}

// Alpaca's distribution reasons, as its docs list them
export const DISTRIBUTION_REASONS: Record<string, DistributionReason> = {
    normal: { label: "Normal distribution (59½ or older)", code: "7", subTypes: ["traditional"], age: "over" },
    early_no_exception: { label: "Early distribution, no known exception (under 59½)", code: "1", subTypes: ["traditional"], age: "under" },
    excess_removal_current_year: { label: "Removal of an excess contribution, taxable this year", code: "8", subTypes: ["traditional"], age: "over" },
    "excess_removal_current_year_under_59.5": { label: "Removal of an excess contribution, taxable this year (under 59½)", code: "81", subTypes: ["traditional"], age: "under" },
    "excess_removal_1_year_prior_over_59.5": { label: "Removal of an excess contribution, taxable the prior year", code: "P", subTypes: ["traditional"], age: "over" },
    "excess_removal_1_year_prior_under_59.5": { label: "Removal of an excess contribution, taxable the prior year (under 59½)", code: "P1", subTypes: ["traditional"], age: "under" },
    normal_roth: { label: "Qualified distribution (59½ and the 5-year period met)", code: "Q", subTypes: ["roth"], age: "over" },
    early_roth_no_exception: { label: "Distribution, no known exception", code: "J", subTypes: ["roth"], age: "any" },
    excess_removal_roth: { label: "Removal of an excess contribution", code: "8J", subTypes: ["roth"], age: "any" },
    excess_removal_1_year_prior_roth: { label: "Removal of an excess contribution from the prior year", code: "PJ", subTypes: ["roth"], age: "any" }
};

// The reasons that fit an account and its owner now
export const distributionReasonsFor = (subType: IraSubType, { dateOfBirth, day, firstContributionYear }: { dateOfBirth: string; day: string; firstContributionYear: number | null }): string[] =>
    Object.keys(DISTRIBUTION_REASONS).filter(reason => distributionReasonError(reason, subType, { dateOfBirth, day, firstContributionYear }) === null);

// Why a distribution reason doesn't fit, or null: it must be one for the account's type and the owner's age; a qualified Roth
// distribution also needs the 5-year period (from January 1 of the first contribution's tax year)
export const distributionReasonError = (reason: string, subType: IraSubType, { dateOfBirth, day, firstContributionYear }: { dateOfBirth: string; day: string; firstContributionYear: number | null }): string | null => {
    const known = DISTRIBUTION_REASONS[reason];
    if (!known) return `distribution_reason must be one of ${Object.keys(DISTRIBUTION_REASONS).join(", ")}`;
    if (!known.subTypes.includes(subType)) return `${reason} is for ${known.subTypes.map(type => IRA_LABELS[type]).join(" or ")}s`;
    const over = reached59AndAHalf(dateOfBirth, day);
    if (known.age === "over" && !over) return `${reason} is for owners 59½ or older${subType === "traditional" ? "; use early_no_exception" : "; use early_roth_no_exception"}`;
    if (known.age === "under" && over) return `${reason} is for owners under 59½${reason === "early_no_exception" ? "; use normal" : ""}`;
    if (reason === "normal_roth" && (firstContributionYear === null || Number(day.slice(0, 4)) < firstContributionYear + 5)) {
        return `a qualified Roth distribution needs 5 years since the first contribution's tax year${firstContributionYear === null ? " (there's none yet)" : ` (${firstContributionYear})`}; use early_roth_no_exception`;
    }
    return null;
};

// Tax withheld from a distribution of amount: federal (10% unless elected otherwise, 0 to opt out) and state, as percentages with up
// to 2 decimals, taken from the amount; what's paid out is the rest
export const distributionWithholding = (amount: number, { fedPct, statePct }: { fedPct?: number | null; statePct?: number | null } = {}) => {
    const fed = fedPct ?? 10;
    const state = statePct ?? 0;
    for (const [label, pct] of [["fed_pct", fed], ["state_pct", state]] as const) {
        if (!Number.isFinite(pct) || pct < 0 || pct > 100 || Math.abs(Math.round(pct * 100) - pct * 100) > 1e-6) throw new Error(`${label} must be from 0 to 100, with up to 2 decimals`);
    }
    if (fed + state > 100) throw new Error("fed_pct and state_pct can't add up to more than 100");
    const fedAmount = Math.round(amount * fed) / 100;
    const stateAmount = Math.round(amount * state) / 100;
    return { fedPct: fed, statePct: state, fedAmount, stateAmount, net: Math.round((amount - fedAmount - stateAmount) * 100) / 100 };
};

export interface BeneficiaryInput {
    given_name: string;
    middle_name?: string | null;
    family_name: string;
    date_of_birth: string;
    tax_id: string;
    tax_id_type?: "USA_SSN";
    relationship: "spouse" | "other";
    type: "primary" | "contingent";
    share_pct: string;
}

const validSsn = (value: string) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 9 && !/^(000|666|9)/.test(digits) && digits.slice(3, 5) !== "00" && digits.slice(5) !== "0000";
};

// Alpaca's beneficiary rules: up to 6; names, a past date of birth and an SSN each; shares above 0 and at most 100 with up to 2
// decimals; at least one primary, the primaries adding up to 100, and the contingents (if any) too
export const beneficiaryErrors = (beneficiaries: BeneficiaryInput[], today: string): string[] => {
    const errors: string[] = [];
    if (beneficiaries.length > 6) errors.push("at most 6 beneficiaries");
    beneficiaries.forEach((beneficiary, index) => {
        const who = `beneficiary ${index + 1}`;
        if (!beneficiary.given_name?.trim() || !beneficiary.family_name?.trim()) errors.push(`${who}: the first and last name are required`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(beneficiary.date_of_birth ?? "") || beneficiary.date_of_birth > today) errors.push(`${who}: a date of birth not in the future is required`);
        if (!validSsn(beneficiary.tax_id ?? "")) errors.push(`${who}: a valid Social Security number is required`);
        if (!["spouse", "other"].includes(beneficiary.relationship)) errors.push(`${who}: relationship must be spouse or other`);
        if (!["primary", "contingent"].includes(beneficiary.type)) errors.push(`${who}: type must be primary or contingent`);
        const share = Number(beneficiary.share_pct);
        if (!(share > 0) || share > 100 || !/^\d+(\.\d{1,2})?$/.test(String(beneficiary.share_pct))) errors.push(`${who}: share_pct must be above 0 and at most 100, with up to 2 decimals`);
    });
    if (beneficiaries.length > 0) {
        const total = (type: string) => Math.round(beneficiaries.filter(entry => entry.type === type).reduce((sum, entry) => sum + Number(entry.share_pct), 0) * 100) / 100;
        if (!beneficiaries.some(({ type }) => type === "primary")) errors.push("at least one primary beneficiary is needed");
        else if (total("primary") !== 100) errors.push(`the primary beneficiaries' shares add up to ${total("primary")}%, not 100%`);
        if (beneficiaries.some(({ type }) => type === "contingent") && total("contingent") !== 100) errors.push(`the contingent beneficiaries' shares add up to ${total("contingent")}%, not 100%`);
    }
    return errors;
};

// Beneficiaries as stored and returned: Alpaca masks their tax IDs (xxx-xx-xxxx) and gives every one a middle_name (null when unset)
export const maskBeneficiaries = (beneficiaries: BeneficiaryInput[]) => beneficiaries.map(beneficiary => ({
    given_name: beneficiary.given_name.trim(), middle_name: beneficiary.middle_name?.trim() || null, family_name: beneficiary.family_name.trim(),
    date_of_birth: beneficiary.date_of_birth, tax_id: "xxx-xx-xxxx", tax_id_type: "USA_SSN" as const, relationship: beneficiary.relationship, type: beneficiary.type,
    share_pct: String(Number(beneficiary.share_pct))
}));

// Where a married owner who doesn't name their spouse as a beneficiary needs the spouse's consent (Alpaca's list, October 2024)
export const COMMUNITY_PROPERTY_STATES = ["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"];

// Whether to ask about spousal consent: the owner lives in a community property state and no spouse is a beneficiary (marital status
// isn't part of the application, so the page asks)
export const spousalConsentMayBeNeeded = (state: string | undefined, beneficiaries: Pick<BeneficiaryInput, "relationship">[]): boolean =>
    COMMUNITY_PROPERTY_STATES.includes((state ?? "").toUpperCase()) && !beneficiaries.some(({ relationship }) => relationship === "spouse");
