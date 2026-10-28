import type { ReactNode } from "react";
import type { AccountApplication, ExperienceLevel, InvestmentObjective, LiquidityNeeds, MaritalStatus, RiskTolerance, TimeHorizon } from "@/lib/kyc";

// The form pieces the onboarding wizard and Settings share: a labeled field, the income and net worth ranges, and the suitability
// questions Alpaca requires for options (optionsSuitabilityErrors in lib/kyc.ts)

export const Field = ({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) => (
    <label className="transfer-field">
        <span className="transfer-field-label">{label}</span>
        {children}
        {hint && <small className="text-muted">{hint}</small>}
        {error && <small className="text-danger">{error}</small>}
    </label>
);

// Income and net worth as Alpaca's min/max pairs; the top range has no maximum
export const RANGES: { label: string; min: string; max?: string }[] = [
    { label: "Under $25,000", min: "0", max: "24999" },
    { label: "$25,000 – $49,999", min: "25000", max: "49999" },
    { label: "$50,000 – $99,999", min: "50000", max: "99999" },
    { label: "$100,000 – $249,999", min: "100000", max: "249999" },
    { label: "$250,000 – $999,999", min: "250000", max: "999999" },
    { label: "$1,000,000 or more", min: "1000000" }
];
export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = { none: "None", "1_to_5_years": "1 to 5 years", over_5_years: "Over 5 years" };
const LIQUIDITY_LABELS: Record<LiquidityNeeds, string> = {
    very_important: "Very important", important: "Important", somewhat_important: "Somewhat important", does_not_matter: "Doesn't matter"
};
const RISK_LABELS: Record<RiskTolerance, string> = { conservative: "Conservative", moderate: "Moderate", significant_risk: "Significant risk" };
const OBJECTIVE_LABELS: Record<InvestmentObjective, string> = {
    generate_income: "Generate income", preserve_wealth: "Preserve wealth", balance_preserve_wealth_with_growth: "Balance preserving wealth with growth",
    growth: "Growth", market_speculation: "Market speculation"
};
const HORIZON_LABELS: Record<TimeHorizon, string> = {
    less_than_1_year: "Less than 1 year", "1_to_2_years": "1 to 2 years", "3_to_5_years": "3 to 5 years", "6_to_10_years": "6 to 10 years", more_than_10_years: "More than 10 years"
};
const MARITAL_LABELS: Record<MaritalStatus, string> = { SINGLE: "Single", MARRIED: "Married", DIVORCED: "Divorced", WIDOWED: "Widowed" };

type Identity = AccountApplication["identity"];
export type SuitabilityAnswers = Pick<Identity, "liquidity_needs" | "risk_tolerance" | "investment_objective" | "investment_time_horizon" | "marital_status" | "number_of_dependents">;
export const SUITABILITY_FIELDS = ["liquidity_needs", "risk_tolerance", "investment_objective", "investment_time_horizon", "marital_status", "number_of_dependents"] as const;

// The suitability questions, with error(path) giving a field's message (validateApplication's paths, such as identity.risk_tolerance)
export const SuitabilityFields = ({ answers, onChange, error = () => undefined }: {
    answers: SuitabilityAnswers; onChange: (changes: Partial<SuitabilityAnswers>) => void; error?: (path: string) => string | undefined;
}) => {
    const select = <K extends Exclude<keyof SuitabilityAnswers, "number_of_dependents">>(field: K, label: string, labels: Record<NonNullable<SuitabilityAnswers[K]>, string>) => (
        <Field label={label} error={error(`identity.${field}`)}>
            <select className="form-control" value={answers[field] ?? ""} onChange={event => onChange({ [field]: event.target.value || undefined } as Partial<SuitabilityAnswers>)}>
                <option value="">Choose…</option>
                {Object.entries(labels).map(([value, text]) => <option key={value} value={value}>{text as string}</option>)}
            </select>
        </Field>
    );
    return (
        <>
            <p className="text-muted mb-0">Options trading also needs these answers, to judge whether options suit you.</p>
            {select("liquidity_needs", "How important is being able to turn this money into cash quickly?", LIQUIDITY_LABELS)}
            {select("risk_tolerance", "Risk tolerance", RISK_LABELS)}
            {select("investment_objective", "Investment objective", OBJECTIVE_LABELS)}
            {select("investment_time_horizon", "How long do you plan to invest?", HORIZON_LABELS)}
            {select("marital_status", "Marital status", MARITAL_LABELS)}
            <Field label="Number of dependents" error={error("identity.number_of_dependents")}>
                <input className="form-control" type="number" min={0} max={99} step={1} inputMode="numeric" value={answers.number_of_dependents ?? ""}
                    onChange={event => onChange({ number_of_dependents: event.target.value === "" ? undefined : Number(event.target.value) })} />
            </Field>
        </>
    );
};
