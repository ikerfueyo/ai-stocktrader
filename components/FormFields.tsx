import type { ReactNode } from "react";
import type { ExperienceLevel, MaritalStatus } from "@/lib/kyc";

// The form pieces the onboarding wizard and Settings share: a labeled field, the income and net worth ranges, and the labels of
// Alpaca's experience and marital status values

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
export const MARITAL_LABELS: Record<MaritalStatus, string> = { SINGLE: "Single", MARRIED: "Married", DIVORCED: "Divorced", WIDOWED: "Widowed" };
