// How the simulator reviews accounts the way Alpaca does (its account statuses: SUBMITTED, then ACTION_REQUIRED, APPROVAL_PENDING,
// APPROVED or REJECTED, then ACTIVE; ACCOUNT_UPDATED while edited personal details are reviewed), options approvals and trading
// configurations. Pure, so it can be unit tested; ./accounts.ts stores the results. Outcomes are deterministic, triggered by the
// applicant's last name for testing: "Reject", "ActionRequired" or "Review" (case-insensitive).
import type { AccountApplication, AgreementName } from "../../../kyc";
import { IRA_MAX_OPTIONS_LEVEL } from "../../../ira";
import type { AccountConfigurations, AccountStatus, KYCResults } from "../types";

// How long each automatic step takes, in seconds (environment overrides for testing)
const SUBMITTED_SECONDS = Number(process.env.SIM_KYC_SECONDS ?? 5);
const REVIEW_SECONDS = Number(process.env.SIM_KYC_REVIEW_SECONDS ?? 60);

export interface KycDecision {
    status: Extract<AccountStatus, "APPROVED" | "ACTION_REQUIRED" | "APPROVAL_PENDING" | "REJECTED">;
    kyc_results: KYCResults | null;
}

const reasons = (...names: string[]) => Object.fromEntries(names.map(name => [name, {}]));

// The outcome of the automatic identity check of a submitted application. Disclosures that a person controls a public company,
// works for an exchange or FINRA member, or is politically exposed always go to manual review, as at a real broker.
export const decideApplication = (application: Pick<AccountApplication, "identity" | "disclosures">): KycDecision => {
    const name = application.identity.family_name.trim().toLowerCase();
    if (name === "reject") {
        return { status: "REJECTED", kyc_results: { reject: reasons("WATCHLIST_HIT"), summary: "fail", additional_information: "The applicant matched a watchlist (simulated)." } };
    }
    if (name === "actionrequired") {
        return {
            status: "ACTION_REQUIRED",
            kyc_results: { indeterminate: reasons("IDENTITY_VERIFICATION"), summary: "fail", additional_information: "Upload a government-issued photo ID to verify your identity." }
        };
    }
    const { is_control_person, is_affiliated_exchange_or_finra, is_politically_exposed, immediate_family_exposed } = application.disclosures;
    if (name === "review" || is_control_person || is_affiliated_exchange_or_finra || is_politically_exposed || immediate_family_exposed) {
        const flagged = [
            is_control_person && "CONTROL_PERSON", is_affiliated_exchange_or_finra && "AFFILIATED", (is_politically_exposed || immediate_family_exposed) && "PEP"
        ].filter((reason): reason is string => Boolean(reason));
        return {
            status: "APPROVAL_PENDING",
            kyc_results: { indeterminate: reasons(...(flagged.length > 0 ? flagged : ["MANUAL_REVIEW"])), summary: "fail", additional_information: "The application is being reviewed manually." }
        };
    }
    return { status: "APPROVED", kyc_results: { summary: "pass" } };
};

// An account as the simulator advances it: its status, when its next automatic step is due, whether documents were uploaded
export interface ReviewState {
    status: AccountStatus;
    dueAt: Date | null;
    documentsUploaded: boolean;
}

export interface ReviewStep {
    status: AccountStatus;
    dueAt: Date | null;
    // Replaces the stored KYC results when set
    kyc_results?: KycDecision["kyc_results"];
}

const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

// When a newly submitted application is decided
export const submittedDueAt = (now: Date) => after(now, SUBMITTED_SECONDS);

// The next automatic step for an account at now, or null when nothing is due: a submitted application gets its decision, a
// manual review or an updated profile is approved after REVIEW_SECONDS, an approved account becomes active, and an account
// waiting on documents goes to review once they're uploaded.
export const nextReviewStep = (state: ReviewState, application: Pick<AccountApplication, "identity" | "disclosures">, now: Date): ReviewStep | null => {
    const due = state.dueAt !== null && state.dueAt <= now;
    switch (state.status) {
        case "SUBMITTED": {
            if (!due) return null;
            const decision = decideApplication(application);
            return {
                status: decision.status,
                kyc_results: decision.kyc_results,
                dueAt: decision.status === "APPROVAL_PENDING" ? after(now, REVIEW_SECONDS) : decision.status === "APPROVED" ? now : null
            };
        }
        case "ACTION_REQUIRED":
            return state.documentsUploaded ? { status: "APPROVAL_PENDING", dueAt: after(now, REVIEW_SECONDS) } : null;
        case "APPROVAL_PENDING":
            return due ? { status: "APPROVED", dueAt: now, kyc_results: { summary: "pass" } } : null;
        case "APPROVED":
            return { status: "ACTIVE", dueAt: null };
        case "ACCOUNT_UPDATED":
            return due ? { status: "ACTIVE", dueAt: null } : null;
        default:
            return null;
    }
};

// The personal details whose change Alpaca reviews (the account goes to ACCOUNT_UPDATED, pausing outgoing transfers), and the
// disclosures whose change from false to true does the same
const REVIEWED_FIELDS = {
    contact: ["street_address", "unit", "city", "state", "postal_code"],
    identity: ["given_name", "family_name", "country_of_citizenship"],
    disclosures: ["employer_name", "employment_position"]
} as const;
const DISCLOSURE_FLAGS = ["is_control_person", "is_affiliated_exchange_or_finra", "is_politically_exposed", "immediate_family_exposed"] as const;

type Section = Record<string, unknown> | undefined;
export const updateNeedsReview = (current: Record<keyof typeof REVIEWED_FIELDS, Section>, update: Partial<Record<keyof typeof REVIEWED_FIELDS, Section>>): boolean => {
    for (const section of Object.keys(REVIEWED_FIELDS) as (keyof typeof REVIEWED_FIELDS)[]) {
        const next = update[section];
        if (!next) continue;
        for (const field of REVIEWED_FIELDS[section]) {
            if (field in next && JSON.stringify(next[field]) !== JSON.stringify(current[section]?.[field])) return true;
        }
    }
    const disclosures = update.disclosures;
    return Boolean(disclosures && DISCLOSURE_FLAGS.some(flag => disclosures[flag] === true && current.disclosures?.[flag] !== true));
};

// The trading configurations an account starts with: margin up to 2x with the margin agreement (4x intraday is opt-in), else 1x;
// options up to the approved level; fractional trading on; trade confirmations by email
// (Alpaca dropped dtbp_check and pdt_check with the pattern day trader rule.)
export const defaultConfigurations = (agreements: AgreementName[]): Required<AccountConfigurations> => ({
    fractional_trading: true,
    max_margin_multiplier: agreements.includes("margin_agreement") ? "2" : "1",
    max_options_trading_level: 0,
    no_shorting: !agreements.includes("margin_agreement"),
    suspend_trade: false,
    trade_confirm_email: "all",
    disable_overnight_trading: true,
    ptp_no_exception_entry: false
});

// Why a configuration change isn't allowed, or null: margin above 1x and shorting need the margin agreement (which an IRA can't have),
// options trading can't exceed the approved level (at most 2 in an IRA), and overnight trading isn't offered
export const configurationError = (update: AccountConfigurations, { hasMarginAgreement, approvedOptionsLevel, ira = false }: { hasMarginAgreement: boolean; approvedOptionsLevel: number; ira?: boolean }): string | null => {
    if (ira && update.max_margin_multiplier !== undefined && update.max_margin_multiplier !== "1") return "IRAs can't use margin";
    if (ira && update.no_shorting === false) return "IRAs can't sell short";
    if (ira && update.max_options_trading_level !== undefined && update.max_options_trading_level > IRA_MAX_OPTIONS_LEVEL) return `IRAs can trade options up to level ${IRA_MAX_OPTIONS_LEVEL}`;
    if (update.max_margin_multiplier !== undefined && !["1", "2", "4"].includes(update.max_margin_multiplier)) return "max_margin_multiplier must be 1, 2 or 4";
    if (update.max_margin_multiplier !== undefined && update.max_margin_multiplier !== "1" && !hasMarginAgreement) return "Margin needs the margin agreement";
    if (update.no_shorting === false && !hasMarginAgreement) return "Short selling needs a margin account (the margin agreement)";
    if (update.max_options_trading_level !== undefined && update.max_options_trading_level > approvedOptionsLevel) {
        return `Options trading is approved up to level ${approvedOptionsLevel}`;
    }
    if (update.disable_overnight_trading === false) return "Overnight trading isn't offered";
    if (update.trade_confirm_email !== undefined && !["all", "none"].includes(update.trade_confirm_email)) return "trade_confirm_email must be all or none";
    return null;
};

// The outcome of an options approval request: it needs the options agreement; spreads (level 3) need some options experience,
// and buying options (level 2) any trading experience, otherwise a lower level is approved
export const decideOptionsApproval = (requested: number, { agreements, stocksExperience, optionsExperience }: {
    agreements: AgreementName[]; stocksExperience?: string; optionsExperience?: string;
}): { status: "APPROVED" | "LOWER_LEVEL_APPROVED" | "REJECTED"; approvedLevel: number } => {
    if (!agreements.includes("options_agreement") || requested < 1 || requested > 3) return { status: "REJECTED", approvedLevel: 0 };
    const hasOptions = optionsExperience !== undefined && optionsExperience !== "none";
    const hasStocks = stocksExperience !== undefined && stocksExperience !== "none";
    const allowed = hasOptions ? 3 : hasStocks ? 2 : 1;
    return requested <= allowed ? { status: "APPROVED", approvedLevel: requested } : { status: "LOWER_LEVEL_APPROVED", approvedLevel: allowed };
};
