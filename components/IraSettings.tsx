"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { beneficiaryErrors, IRA_LABELS, spousalConsentMayBeNeeded, type BeneficiaryInput, type IraSubType } from "@/lib/ira";
import type { IraOverview, OpenIraRequest } from "@/lib/types";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const blank = (type: "primary" | "contingent" = "primary"): BeneficiaryInput => ({ given_name: "", family_name: "", date_of_birth: "", tax_id: "", relationship: "other", type, share_pct: "100" });

// Rows of beneficiaries to fill in (up to 6): name, date of birth, SSN, relationship, primary or contingent, and share
export const BeneficiaryFields = ({ beneficiaries, setBeneficiaries }: { beneficiaries: BeneficiaryInput[]; setBeneficiaries: (beneficiaries: BeneficiaryInput[]) => void }) => {
    const update = (index: number, changes: Partial<BeneficiaryInput>) => setBeneficiaries(beneficiaries.map((entry, i) => i === index ? { ...entry, ...changes } : entry));
    return (
        <div className="beneficiaries">
            {beneficiaries.map((beneficiary, index) => (
                <div className="beneficiary-row" key={index}>
                    <input className="form-control" placeholder="First name" aria-label="First name" value={beneficiary.given_name} onChange={event => update(index, { given_name: event.target.value })} />
                    <input className="form-control" placeholder="Last name" aria-label="Last name" value={beneficiary.family_name} onChange={event => update(index, { family_name: event.target.value })} />
                    <input className="form-control" type="date" aria-label="Date of birth" max={today()} value={beneficiary.date_of_birth} onChange={event => update(index, { date_of_birth: event.target.value })} />
                    <input className="form-control" placeholder="SSN" aria-label="Social Security number" inputMode="numeric" autoComplete="off" value={beneficiary.tax_id} onChange={event => update(index, { tax_id: event.target.value })} />
                    <select className="form-control" aria-label="Relationship" value={beneficiary.relationship} onChange={event => update(index, { relationship: event.target.value as BeneficiaryInput["relationship"] })}>
                        <option value="spouse">Spouse</option>
                        <option value="other">Other</option>
                    </select>
                    <select className="form-control" aria-label="Primary or contingent" value={beneficiary.type} onChange={event => update(index, { type: event.target.value as BeneficiaryInput["type"] })}>
                        <option value="primary">Primary</option>
                        <option value="contingent">Contingent</option>
                    </select>
                    <div className="input-group beneficiary-share">
                        <input className="form-control" inputMode="decimal" aria-label="Share" value={beneficiary.share_pct} onChange={event => update(index, { share_pct: event.target.value })} />
                        <div className="input-group-append"><span className="input-group-text">%</span></div>
                    </div>
                    <button type="button" className="btn btn-link btn-sm text-danger" onClick={() => setBeneficiaries(beneficiaries.filter((_, i) => i !== index))}>Remove</button>
                </div>
            ))}
            {beneficiaries.length < 6 && (
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setBeneficiaries([...beneficiaries, blank(beneficiaries.some(({ type }) => type === "primary") ? "contingent" : "primary")])}>
                    Add a beneficiary
                </button>
            )}
            <p className="text-muted small">Primary beneficiaries&apos; shares must add up to 100%, and contingent ones&apos; too. Social Security numbers aren&apos;t kept: they&apos;re asked again whenever the list changes.</p>
        </div>
    );
};

// The IRA's beneficiaries, replaced all at once (PATCH /api/accounts/[id] { beneficiaries }), as Alpaca replaces them
export const Beneficiaries = ({ accountId, state, onSaved }: { accountId: string; state?: string; onSaved: () => void }) => {
    const [overview, setOverview] = useState<IraOverview | null>(null);
    const [editing, setEditing] = useState<BeneficiaryInput[] | null>(null);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const load = async () => {
            try {
                setOverview((await axios.get<IraOverview>("/api/ira")).data);
            } catch (error) {
                logError(error);
            }
        };
        load();
    }, [version]);
    const current = overview?.account?.beneficiaries ?? [];
    const save = async () => {
        const problems = beneficiaryErrors(editing!, today());
        if (problems.length > 0) return setMessage({ ok: false, text: problems.join("; ") });
        try {
            await axios.patch(`/api/accounts/${accountId}`, { beneficiaries: editing });
            setEditing(null);
            setMessage({ ok: true, text: "Beneficiaries saved." });
            setVersion(value => value + 1);
            onSaved();
        } catch (error) {
            setMessage({ ok: false, text: apiErrorMessage(error) });
        }
    };
    return (
        <Fragment>
            {current.length === 0 ? <p className="text-muted">No beneficiaries yet: without one, the IRA goes to your estate.</p> : (
                <ul className="beneficiary-list">
                    {current.map((entry, index) => <li key={index}>{entry.given_name} {entry.family_name} · {entry.relationship} · {entry.type} · {Number(entry.share_pct)}%</li>)}
                </ul>
            )}
            {overview?.account?.spousalConsentMayBeNeeded && (
                <p className="text-warning small">You live in a community property state{state ? ` (${state})` : ""}: if you&apos;re married and your spouse isn&apos;t a primary beneficiary, your spouse&apos;s consent is needed.</p>
            )}
            {editing ? (
                <Fragment>
                    <BeneficiaryFields beneficiaries={editing} setBeneficiaries={setEditing} />
                    <div className="onboarding-buttons">
                        <button type="button" className="btn btn-outline-dark" onClick={() => setEditing(null)}>Cancel</button>
                        <button type="button" className="btn btn-dark" onClick={save}>Save beneficiaries</button>
                    </div>
                </Fragment>
            ) : (
                <button type="button" className="btn btn-outline-dark" onClick={() => setEditing(current.length > 0 ? current.map(entry => ({ ...entry, middle_name: entry.middle_name ?? null, tax_id: "" })) : [blank()])}>
                    {current.length > 0 ? "Change beneficiaries" : "Add beneficiaries"}
                </button>
            )}
            {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
        </Fragment>
    );
};

const DESCRIPTIONS: Record<IraSubType, string> = {
    traditional: "Contributions may be tax-deductible; withdrawals are taxed as income, with a 10% penalty before 59½ unless an exception applies. Required distributions start at 73 or 75.",
    roth: "Contributions are made after tax (income limits apply); qualified withdrawals, from 59½ and 5 years after the first contribution, are tax-free. No required distributions."
};

// Opens a traditional or Roth IRA from the individual account (POST /api/accounts/ira): the IRA's type, the SSN again, beneficiaries
// and the agreements. It's reviewed like any application, then appears in the account menu.
export const OpenIra = ({ state, onOpened }: { state?: string; onOpened: () => void }) => {
    const [overview, setOverview] = useState<IraOverview | null>(null);
    const [subType, setSubType] = useState<IraSubType | null>(null);
    const [taxId, setTaxId] = useState("");
    const [beneficiaries, setBeneficiaries] = useState<BeneficiaryInput[]>([]);
    const [agreements, setAgreements] = useState(false);
    const [disclosure, setDisclosure] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    useEffect(() => {
        const load = async () => {
            try {
                setOverview((await axios.get<IraOverview>("/api/ira")).data);
            } catch (error) {
                logError(error);
            }
        };
        load();
    }, []);
    const available = (["traditional", "roth"] as IraSubType[]).filter(type => !overview?.openKinds.includes(type === "traditional" ? "traditional_ira" : "roth_ira"));
    const limit = overview?.years[0];
    if (overview && available.length === 0) return <p className="text-muted">You have both a traditional and a Roth IRA; switch to one in the account menu.</p>;

    const submit = async () => {
        if (!subType) return;
        const problems = beneficiaryErrors(beneficiaries, today());
        if (problems.length > 0) return setMessage({ ok: false, text: problems.join("; ") });
        setSubmitting(true);
        setMessage(null);
        try {
            const body: OpenIraRequest = { subType, taxId, beneficiaries, acceptedAgreements: agreements, iraDisclosure: disclosure };
            await axios.post("/api/accounts/ira", body);
            setMessage({ ok: true, text: `Your ${IRA_LABELS[subType]} was submitted for review. Once it's open, switch to it in the account menu to fund it.` });
            setSubType(null);
            setTaxId("");
            onOpened();
        } catch (error) {
            setMessage({ ok: false, text: apiErrorMessage(error) });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Fragment>
            <p className="text-muted">
                A separate account for retirement, using this account&apos;s details. IRAs trade without margin or short selling, with options up to level 2.
                {limit ? ` The ${limit.taxYear} contribution limit is $${limit.limit.toLocaleString("en-US")} across all your IRAs.` : ""}
            </p>
            <div className="ira-types">
                {available.map(type => (
                    <label key={type} className={`ira-type ${subType === type ? "selected" : ""}`}>
                        <input type="radio" name="ira-type" checked={subType === type} onChange={() => setSubType(type)} />
                        <strong>{IRA_LABELS[type]}</strong>
                        <span className="text-muted small">{DESCRIPTIONS[type]}</span>
                    </label>
                ))}
            </div>
            {subType && (
                <div className="transfer-fields">
                    <label className="transfer-field">
                        <span className="transfer-field-label">Your Social Security number (it isn&apos;t kept, so it&apos;s asked again)</span>
                        <input className="form-control" inputMode="numeric" autoComplete="off" value={taxId} onChange={event => setTaxId(event.target.value)} />
                    </label>
                    <span className="transfer-field-label">Beneficiaries (optional now, can be added later)</span>
                    <BeneficiaryFields beneficiaries={beneficiaries} setBeneficiaries={setBeneficiaries} />
                    {spousalConsentMayBeNeeded(state, beneficiaries) && <p className="text-warning small">In a community property state, a married owner whose spouse isn&apos;t a primary beneficiary needs the spouse&apos;s consent.</p>}
                    <label className="onboarding-check">
                        <input type="checkbox" checked={agreements} onChange={event => setAgreements(event.target.checked)} />
                        I accept the <Link href="/agreements/customer_agreement" target="_blank">customer agreement</Link> and the <Link href="/agreements/account_agreement" target="_blank">account agreement</Link> for the IRA
                    </label>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={disclosure} onChange={event => setDisclosure(event.target.checked)} />
                        I&apos;ve read the <Link href="/agreements/ira_disclosure" target="_blank">IRA disclosure statement and custodial agreement</Link>
                    </label>
                    <button type="button" className="btn btn-dark" disabled={submitting || !agreements || !disclosure || taxId.replace(/\D/g, "").length !== 9} onClick={submit}>
                        {submitting ? "Submitting..." : `Open a ${IRA_LABELS[subType]}`}
                    </button>
                </div>
            )}
            {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
        </Fragment>
    );
};
