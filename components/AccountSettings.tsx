"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { EXPERIENCE_LEVELS, US_STATES, type ExperienceLevel } from "@/lib/kyc";
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
// contact, trading configurations, upgrades to margin and options, and closing the account
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
    const [optionsExperience, setOptionsExperience] = useState<ExperienceLevel | "">("");
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
    const noticeFor = (section: string) => notice?.section === section && <p className={notice.error ? "text-danger" : "text-success"}>{notice.text}</p>;

    if (error) return <p className="text-danger text-center mt-5">Couldn&apos;t load your account: {error}</p>;
    if (!account || !configurations || !active) return <p className="text-center mt-5">Loading...</p>;

    const agreements = (account.agreements ?? []).map(({ agreement }) => agreement);
    const isMargin = agreements.includes("margin_agreement");
    const approvedLevel = configurations.max_options_trading_level ?? 0;
    const latestApproval = approvals[0];

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
    const onUpgradeMargin = () => save("margin", async () => {
        await patchAccount({ agreements: [{ agreement: "margin_agreement" }] });
        await patchConfigurations({ max_margin_multiplier: "2", no_shorting: false });
    }, "Your account is now a margin account.");
    const onRequestOptions = () => save("options", async () => {
        if (!agreements.includes("options_agreement") || (optionsExperience && optionsExperience !== account.identity?.investment_experience_with_options)) {
            await patchAccount({
                ...(agreements.includes("options_agreement") ? {} : { agreements: [{ agreement: "options_agreement" }] }),
                ...(optionsExperience ? { identity: { investment_experience_with_options: optionsExperience } } : {})
            });
        }
        await axios.post(`/api/accounts/${id}/options`, { level: optionsLevel });
    }, "Requested. The decision takes a few seconds.");
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
                </div>
            </Section>

            {!isMargin && (
                <Section title="Upgrade to margin">
                    <p className="text-muted">Borrow against your stocks and sell short. Borrowing costs interest, and you can lose more than you deposit.</p>
                    <label className="onboarding-check">
                        <input type="checkbox" checked={acceptMargin} onChange={event => setAcceptMargin(event.target.checked)} />
                        I&apos;ve read and accept the <Link href="/agreements/margin_agreement" target="_blank">margin agreement</Link>
                    </label>
                    {noticeFor("margin")}
                    <button type="button" className="btn btn-dark" disabled={!acceptMargin} onClick={onUpgradeMargin}>Upgrade to margin</button>
                </Section>
            )}

            <Section title="Options trading">
                {latestApproval?.status && <p className="text-muted">Latest request: level {latestApproval.requested_level}, {latestApproval.status.toLowerCase().replaceAll("_", " ")}{latestApproval.status !== "PENDING" && latestApproval.status !== "REJECTED" ? ` (level ${latestApproval.approved_level} approved)` : ""}.</p>}
                {approvedLevel < 3 && !pendingApproval && (
                    <div className="transfer-fields">
                        <select className="form-control" aria-label="Options level" value={optionsLevel} onChange={event => setOptionsLevel(Number(event.target.value))}>
                            {[1, 2, 3].filter(level => level > approvedLevel).map(level => <option key={level} value={level}>{OPTIONS_LEVEL_LABELS[level]}</option>)}
                        </select>
                        {!account.identity?.investment_experience_with_options && (
                            <select className="form-control" aria-label="Options experience" value={optionsExperience} onChange={event => setOptionsExperience(event.target.value as ExperienceLevel | "")}>
                                <option value="">Your options experience…</option>
                                {EXPERIENCE_LEVELS.map(level => <option key={level} value={level}>{level === "none" ? "None" : level === "1_to_5_years" ? "1 to 5 years" : "Over 5 years"}</option>)}
                            </select>
                        )}
                        {!agreements.includes("options_agreement") && (
                            <label className="onboarding-check">
                                <input type="checkbox" checked={acceptOptions} onChange={event => setAcceptOptions(event.target.checked)} />
                                I&apos;ve read and accept the <Link href="/agreements/options_agreement" target="_blank">options agreement</Link>
                            </label>
                        )}
                        {noticeFor("options")}
                        <button type="button" className="btn btn-dark"
                            disabled={(!agreements.includes("options_agreement") && !acceptOptions) || (!account.identity?.investment_experience_with_options && !optionsExperience)}
                            onClick={onRequestOptions}>Request options approval</button>
                    </div>
                )}
                <p className="text-muted">Options trading itself arrives in a later version; approval can be requested now.</p>
            </Section>

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
