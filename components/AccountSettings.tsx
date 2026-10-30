"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Beneficiaries, OpenIra } from "./IraSettings";
import { IRA_MAX_OPTIONS_LEVEL } from "@/lib/ira";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import W9Certification from "./W9Certification";
import { EXPERIENCE_LEVELS, US_STATES, optionsSuitabilityErrors, type AccountApplication, type ExperienceLevel } from "@/lib/kyc";
import { EXPERIENCE_LABELS, Field, RANGES, SUITABILITY_FIELDS, SuitabilityFields, type SuitabilityAnswers } from "./OptionsSuitability";
import type { AccountConfigurations, BrokerAccount, OptionsApprovalResponse } from "@/lib/types";

const OPTIONS_LEVEL_LABELS = ["None", "Level 1: covered calls and cash-secured puts", "Level 2: also buying calls and puts", "Level 3: also spreads"];
const STATUS_LABELS: Record<string, string> = { ACTIVE: "Active", ACCOUNT_UPDATED: "Active, updated details under review" };

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="settings-section">
        <h2 className="panel-title">{title}</h2>
        {children}
    </section>
);

// Account settings: the account's details, contact and employment (an edited address, name or employer is reviewed), the trusted
// contact, trading configurations, upgrades to margin and options, the W-9 certification, and closing the account
const AccountSettings = () => {
    const { active, refreshAccounts } = useBrokerAccount();
    const [account, setAccount] = useState<BrokerAccount | null>(null);
    const [configurations, setConfigurations] = useState<AccountConfigurations | null>(null);
    const [approvals, setApprovals] = useState<OptionsApprovalResponse[]>([]);
    const [error, setError] = useState<string | null>(null);
    // The section that last saved, and a message for it
    const [notice, setNotice] = useState<{ section: string; text: string; error?: boolean } | null>(null);
    const [contact, setContact] = useState({ email_address: "", phone_number: "", street: "", street2: "", city: "", state: "", postal_code: "" });
    const [employment, setEmployment] = useState({ employment_status: "", employer_name: "", employment_position: "" });
    const [trusted, setTrusted] = useState({ given_name: "", family_name: "", email_address: "", phone_number: "" });
    const [optionsLevel, setOptionsLevel] = useState(1);
    const [stocksExperience, setStocksExperience] = useState<ExperienceLevel | "">("");
    const [optionsExperience, setOptionsExperience] = useState<ExperienceLevel | "">("");
    // What an options request adds to the account's identity when it lacks them: annual income and the suitability answers
    const [annualIncome, setAnnualIncome] = useState(-1);
    const [suitability, setSuitability] = useState<SuitabilityAnswers>({});
    const [acceptOptions, setAcceptOptions] = useState(false);
    const [acceptMargin, setAcceptMargin] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);

    const id = active?.accountId;
    const load = useCallback(async () => {
        if (!id) return;
        try {
            const [accountResponse, configurationsResponse, approvalsResponse] = await Promise.all([
                axios.get<BrokerAccount>(`/api/accounts/${id}`),
                axios.get<AccountConfigurations>(`/api/accounts/${id}/configurations`),
                axios.get<OptionsApprovalResponse[]>(`/api/accounts/${id}/options`)
            ]);
            const loaded = accountResponse.data;
            setAccount(loaded);
            setConfigurations(configurationsResponse.data);
            setApprovals(approvalsResponse.data);
            const [street = "", street2 = ""] = loaded.contact?.street_address ?? [];
            setContact({
                email_address: loaded.contact?.email_address ?? "", phone_number: loaded.contact?.phone_number ?? "", street, street2,
                city: loaded.contact?.city ?? "", state: loaded.contact?.state ?? "", postal_code: loaded.contact?.postal_code ?? ""
            });
            setEmployment({
                employment_status: loaded.disclosures?.employment_status ?? "", employer_name: loaded.disclosures?.employer_name ?? "",
                employment_position: loaded.disclosures?.employment_position ?? ""
            });
            const trustedContact = loaded.trusted_contact as Partial<typeof trusted> | undefined;
            setTrusted({
                given_name: trustedContact?.given_name ?? "", family_name: trustedContact?.family_name ?? "",
                email_address: trustedContact?.email_address ?? "", phone_number: trustedContact?.phone_number ?? ""
            });
            setError(null);
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        }
    }, [id]);

    useEffect(() => {
        // load only sets state once its requests finish
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [load]);

    // Polls while an options request is being decided
    const pendingApproval = approvals.some(({ status }) => status === "PENDING");
    useEffect(() => {
        if (!pendingApproval) return;
        const timer = setInterval(load, 3000);
        return () => clearInterval(timer);
    }, [pendingApproval, load]);

    // Runs a change, reloads the account and shows success (or, as a function, what to say given the request's result)
    const save = async <T,>(section: string, request: () => Promise<T>, success: string | ((result: T) => string)) => {
        setNotice(null);
        try {
            const result = await request();
            await Promise.all([load(), refreshAccounts()]);
            setNotice({ section, text: typeof success === "function" ? success(result) : success });
        } catch (error) {
            logError(error);
            setNotice({ section, text: apiErrorMessage(error), error: true });
        }
    };
    const patchAccount = (body: object) => axios.patch<BrokerAccount>(`/api/accounts/${id}`, body);
    // An edited address, name or employer puts the account under review
    const reviewNotice = ({ data }: { data: BrokerAccount }) => data.status === "ACCOUNT_UPDATED"
        ? "Saved. Your new details are being reviewed; withdrawals resume once they're approved."
        : "Saved.";
    const patchConfigurations = (body: AccountConfigurations) => axios.patch(`/api/accounts/${id}/configurations`, body);
    const noticeFor = (section: string) => notice?.section === section && notice.text && <p className={notice.error ? "text-danger" : "text-success"}>{notice.text}</p>;

    if (error) return <p className="text-danger text-center mt-5">Couldn&apos;t load your account: {error}</p>;
    if (!account || !configurations || !active) return <p className="text-center mt-5">Loading...</p>;

    const agreements = (account.agreements ?? []).map(({ agreement }) => agreement);
    const isMargin = agreements.includes("margin_agreement");
    const isIra = account.account_type === "ira";
    // IRAs trade options up to level 2
    const maxLevel = isIra ? IRA_MAX_OPTIONS_LEVEL : 3;
    const approvedLevel = configurations.max_options_trading_level ?? 0;
    const latestApproval = approvals[0];
    // The levels that can be requested; the choice falls back to the lowest when it isn't one of them (such as after an approval)
    const levelChoices = [1, 2, 3].filter(level => level > approvedLevel && level <= maxLevel);
    const requestLevel = levelChoices.includes(optionsLevel) ? optionsLevel : levelChoices[0];
    // An account opened without options lacks the answers Alpaca requires for them, which the request then adds
    const identity = (account.identity ?? {}) as AccountApplication["identity"];
    const needsIncome = identity.annual_income_min === undefined;
    const needsSuitability = SUITABILITY_FIELDS.some(field => identity[field] === undefined);
    const income = RANGES[annualIncome];
    const identityChanges: Partial<AccountApplication["identity"]> = {
        ...(stocksExperience && stocksExperience !== identity.investment_experience_with_stocks ? { investment_experience_with_stocks: stocksExperience } : {}),
        ...(optionsExperience && optionsExperience !== identity.investment_experience_with_options ? { investment_experience_with_options: optionsExperience } : {}),
        ...(needsIncome && income ? { annual_income_min: income.min, annual_income_max: income.max } : {}),
        ...(needsSuitability ? suitability : {})
    };
    const optionsReady = Object.keys(optionsSuitabilityErrors({ ...identity, ...identityChanges })).length === 0;

    const onContact = (event: FormEvent) => {
        event.preventDefault();
        save("contact", () => patchAccount({
            contact: {
                email_address: contact.email_address, phone_number: contact.phone_number, street_address: [contact.street, contact.street2].filter(Boolean),
                city: contact.city, state: contact.state, postal_code: contact.postal_code
            }
        }), reviewNotice);
    };
    const onEmployment = (event: FormEvent) => {
        event.preventDefault();
        save("employment", () => patchAccount({ disclosures: { ...employment, employment_status: employment.employment_status || undefined } }), reviewNotice);
    };
    const onTrusted = (event: FormEvent) => {
        event.preventDefault();
        save("trusted", () => patchAccount({ trusted_contact: trusted }), "Saved.");
    };
    // The broker can refuse 2x after accepting the agreement (Alpaca's "exceeds the current limit 1", 422): the agreement stays
    // signed and the account stays at 1x until the broker raises its limit
    const onUpgradeMargin = () => save("margin", async () => {
        await patchAccount({ agreements: [{ agreement: "margin_agreement" }] });
        try {
            await patchConfigurations({ max_margin_multiplier: "2", no_shorting: false });
            return true;
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 422) {
                logError(error);
                return false;
            }
            throw error;
        }
    }, raised => raised ? "Your account is now a margin account."
        : "The margin agreement is signed, but the broker hasn't raised your limit above 1x yet (margin needs $2,000 of equity). Choose 2× under Maximum margin once it does.");
    const onRequestOptions = () => save("options", async () => {
        if (!agreements.includes("options_agreement") || Object.keys(identityChanges).length > 0) {
            await patchAccount({
                ...(agreements.includes("options_agreement") ? {} : { agreements: [{ agreement: "options_agreement" }] }),
                ...(Object.keys(identityChanges).length > 0 ? { identity: identityChanges } : {})
            });
        }
        await axios.post(`/api/accounts/${id}/options`, { level: requestLevel });
    // No notice: the latest request's line says it's pending, then how it was decided
    }, "");
    const onClose = () => save("close", async () => {
        await axios.post(`/api/accounts/${id}/close`);
    }, "Your account is closed.");

    return (
        <main className="transfer-container settings mt-5">
            <h1 className="transfer-title">Settings</h1>

            <Section title="Account">
                <dl className="onboarding-review">
                    <dt>Account number</dt><dd>{account.account_number}</dd>
                    <dt>Status</dt><dd>{STATUS_LABELS[account.status] ?? account.status}</dd>
                    <dt>Type</dt><dd>{isMargin ? "Margin" : "Cash"} account</dd>
                    <dt>Options</dt><dd>{OPTIONS_LEVEL_LABELS[approvedLevel]}</dd>
                    <dt>Opened</dt><dd>{new Date(account.created_at).toLocaleDateString("en-US", { dateStyle: "medium" })}</dd>
                    <dt>Name</dt><dd>{[account.identity?.given_name, account.identity?.family_name].join(" ")}</dd>
                    <dt>Tax ID</dt><dd>{account.identity?.tax_id}</dd>
                </dl>
            </Section>

            <Section title="Contact">
                <form className="transfer-fields" onSubmit={onContact}>
                    <input className="form-control" type="email" aria-label="Email" value={contact.email_address} onChange={event => setContact({ ...contact, email_address: event.target.value })} />
                    <input className="form-control" type="tel" aria-label="Phone" value={contact.phone_number} onChange={event => setContact({ ...contact, phone_number: event.target.value })} />
                    <input className="form-control" aria-label="Street address" value={contact.street} onChange={event => setContact({ ...contact, street: event.target.value })} />
                    <input className="form-control" aria-label="Apartment, suite" placeholder="Apartment, suite (optional)" value={contact.street2} onChange={event => setContact({ ...contact, street2: event.target.value })} />
                    <div className="transfer-row">
                        <input className="form-control" aria-label="City" value={contact.city} onChange={event => setContact({ ...contact, city: event.target.value })} />
                        <select className="form-control" aria-label="State" value={contact.state} onChange={event => setContact({ ...contact, state: event.target.value })}>
                            {US_STATES.map(state => <option key={state}>{state}</option>)}
                        </select>
                        <input className="form-control" aria-label="ZIP" value={contact.postal_code} onChange={event => setContact({ ...contact, postal_code: event.target.value })} />
                    </div>
                    {noticeFor("contact")}
                    <button type="submit" className="btn btn-dark">Save contact details</button>
                </form>
            </Section>

            <Section title="Employment">
                <form className="transfer-fields" onSubmit={onEmployment}>
                    <select className="form-control" aria-label="Employment status" value={employment.employment_status} onChange={event => setEmployment({ ...employment, employment_status: event.target.value })}>
                        <option value="employed">Employed</option>
                        <option value="unemployed">Unemployed</option>
                        <option value="student">Student</option>
                        <option value="retired">Retired</option>
                    </select>
                    {employment.employment_status === "employed" && (
                        <div className="transfer-row">
                            <input className="form-control" aria-label="Employer" placeholder="Employer" value={employment.employer_name} onChange={event => setEmployment({ ...employment, employer_name: event.target.value })} />
                            <input className="form-control" aria-label="Position" placeholder="Position" value={employment.employment_position} onChange={event => setEmployment({ ...employment, employment_position: event.target.value })} />
                        </div>
                    )}
                    {noticeFor("employment")}
                    <button type="submit" className="btn btn-dark">Save employment</button>
                </form>
            </Section>

            <Section title="Trusted contact">
                <form className="transfer-fields" onSubmit={onTrusted}>
                    <div className="transfer-row">
                        <input className="form-control" aria-label="Trusted contact's first name" placeholder="First name" value={trusted.given_name} onChange={event => setTrusted({ ...trusted, given_name: event.target.value })} />
                        <input className="form-control" aria-label="Trusted contact's last name" placeholder="Last name" value={trusted.family_name} onChange={event => setTrusted({ ...trusted, family_name: event.target.value })} />
                    </div>
                    <div className="transfer-row">
                        <input className="form-control" type="email" aria-label="Trusted contact's email" placeholder="Email" value={trusted.email_address} onChange={event => setTrusted({ ...trusted, email_address: event.target.value })} />
                        <input className="form-control" type="tel" aria-label="Trusted contact's phone" placeholder="Phone" value={trusted.phone_number} onChange={event => setTrusted({ ...trusted, phone_number: event.target.value })} />
                    </div>
                    {noticeFor("trusted")}
                    <button type="submit" className="btn btn-dark">Save trusted contact</button>
                </form>
            </Section>

            <Section title="Trading">
                <div className="transfer-fields">
                    <label className="onboarding-check">
                        <input type="checkbox" checked={configurations.fractional_trading ?? true} onChange={event => save("trading", () => patchConfigurations({ fractional_trading: event.target.checked }), "Saved.")} />
                        Fractional shares and dollar-amount orders
                    </label>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={configurations.trade_confirm_email === "all"} onChange={event => save("trading", () => patchConfigurations({ trade_confirm_email: event.target.checked ? "all" : "none" }), "Saved.")} />
                        Email a confirmation of each trade
                    </label>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={configurations.suspend_trade ?? false} onChange={event => save("trading", () => patchConfigurations({ suspend_trade: event.target.checked }), event.target.checked ? "Trading is suspended until you turn this off." : "Trading is back on.")} />
                        Suspend trading on this account
                    </label>
                    {isMargin && (
                        <>
                            <label className="onboarding-check">
                                <input type="checkbox" checked={!configurations.no_shorting} onChange={event => save("trading", () => patchConfigurations({ no_shorting: !event.target.checked }), "Saved.")} />
                                Allow short selling
                            </label>
                            <label className="transfer-field">
                                <span className="transfer-field-label">Maximum margin</span>
                                <select className="form-control" value={configurations.max_margin_multiplier ?? "1"} onChange={event => save("trading", () => patchConfigurations({ max_margin_multiplier: event.target.value }), "Saved.")}>
                                    <option value="1">1× (no borrowing)</option>
                                    <option value="2">2× (Reg T overnight)</option>
                                    <option value="4">4× intraday, 2× overnight</option>
                                </select>
                                <small className="text-muted">Margin needs at least $2,000 of equity; below that buying power is 1×.</small>
                            </label>
                        </>
                    )}
                    {noticeFor("trading")}
                    {/* The upgrade's outcome shows here, by the margin settings, as its own section goes once the agreement is signed */}
                    {noticeFor("margin")}
                </div>
            </Section>

            {isIra ? (
                <Section title="Beneficiaries">
                    <Beneficiaries accountId={account.id} state={account.contact?.state} maritalStatus={account.identity?.marital_status} onSaved={load} />
                </Section>
            ) : (
                <Section title="Retirement accounts (IRAs)">
                    <OpenIra state={account.contact?.state} maritalStatus={account.identity?.marital_status} onOpened={refreshAccounts} />
                </Section>
            )}

            {!isMargin && !isIra && (
                <Section title="Upgrade to margin">
                    <p className="text-muted">Borrow against your stocks and sell short. Borrowing costs interest, and you can lose more than you deposit.</p>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={acceptMargin} onChange={event => setAcceptMargin(event.target.checked)} />
                        I&apos;ve read and accept the <Link href="/agreements/margin_agreement" target="_blank">margin agreement</Link>
                    </label>
                    <button type="button" className="btn btn-dark" disabled={!acceptMargin} onClick={onUpgradeMargin}>Upgrade to margin</button>
                </Section>
            )}

            <Section title="Options trading">
                {latestApproval?.status && <p className="text-muted">Latest request: level {latestApproval.requested_level}, {latestApproval.status.toLowerCase().replaceAll("_", " ")}{latestApproval.status !== "PENDING" && latestApproval.status !== "REJECTED" ? ` (level ${latestApproval.approved_level} approved)` : ""}{latestApproval.status === "PENDING" ? "; the decision takes a few seconds" : ""}.</p>}
                {approvedLevel < maxLevel && !pendingApproval && (
                    <div className="transfer-fields">
                        <select className="form-control" aria-label="Options level" value={requestLevel} onChange={event => setOptionsLevel(Number(event.target.value))}>
                            {levelChoices.map(level => <option key={level} value={level}>{OPTIONS_LEVEL_LABELS[level]}</option>)}
                        </select>
                        {/* The experience decides the level approved: level 2 needs experience trading stocks, level 3 trading options */}
                        <Field label="Your experience trading stocks">
                            <select className="form-control" value={stocksExperience || identity.investment_experience_with_stocks || ""} onChange={event => setStocksExperience(event.target.value as ExperienceLevel | "")}>
                                <option value="">Choose…</option>
                                {EXPERIENCE_LEVELS.map(level => <option key={level} value={level}>{EXPERIENCE_LABELS[level]}</option>)}
                            </select>
                        </Field>
                        <Field label="Your experience trading options">
                            <select className="form-control" value={optionsExperience || identity.investment_experience_with_options || ""} onChange={event => setOptionsExperience(event.target.value as ExperienceLevel | "")}>
                                <option value="">Choose…</option>
                                {EXPERIENCE_LEVELS.map(level => <option key={level} value={level}>{EXPERIENCE_LABELS[level]}</option>)}
                            </select>
                        </Field>
                        <p className="text-muted">Level 2 needs experience trading stocks and level 3 trading options; a request beyond your experience is approved at a lower level.</p>
                        {needsIncome && (
                            <Field label="Annual income">
                                <select className="form-control" value={annualIncome} onChange={event => setAnnualIncome(Number(event.target.value))}>
                                    <option value={-1}>Choose…</option>
                                    {RANGES.map(({ label }, index) => <option key={label} value={index}>{label}</option>)}
                                </select>
                            </Field>
                        )}
                        {needsSuitability && <SuitabilityFields answers={{ ...identity, ...suitability }} onChange={changes => setSuitability(previous => ({ ...previous, ...changes }))} />}
                        {!agreements.includes("options_agreement") && (
                            <label className="onboarding-check">
                                <input type="checkbox" checked={acceptOptions} onChange={event => setAcceptOptions(event.target.checked)} />
                                I&apos;ve read and accept the <Link href="/agreements/options_agreement" target="_blank">options agreement</Link>
                            </label>
                        )}
                        {noticeFor("options")}
                        <button type="button" className="btn btn-dark"
                            disabled={(!agreements.includes("options_agreement") && !acceptOptions) || !optionsReady}
                            onClick={onRequestOptions}>Request options approval</button>
                    </div>
                )}
                {isIra && <p className="text-muted">IRAs can trade options up to level 2: covered calls, cash-secured puts, and buying calls and puts.</p>}
            </Section>

            {isIra ? (
                <Section title="Taxes">
                    <p className="text-muted">An IRA isn&apos;t subject to backup withholding, and its trades and dividends aren&apos;t reported each year. Its tax forms are the 1099-R (distributions) and the 5498 (contributions and year-end value), on the Documents page, with an RMD notice each year a traditional IRA&apos;s required minimum distribution is due.</p>
                </Section>
            ) : (
                <Section title="Tax certification (W-9)">
                    <W9Certification accountId={account.id} />
                </Section>
            )}

            <Section title="Close account">
                <p className="text-muted">Close your positions, cancel your open orders and withdraw your cash first. Your records are kept.</p>
                {noticeFor("close")}
                {confirmClose ? (
                    <div className="onboarding-buttons">
                        <button type="button" className="btn btn-outline-dark" onClick={() => setConfirmClose(false)}>Keep my account</button>
                        <button type="button" className="btn btn-danger" onClick={onClose}>Close account {account.account_number}</button>
                    </div>
                ) : (
                    <button type="button" className="btn btn-outline-danger" onClick={() => setConfirmClose(true)}>Close account…</button>
                )}
            </Section>
        </main>
    );
};

export default AccountSettings;
