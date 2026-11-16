"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Beneficiaries, OpenIra } from "./IraSettings";
import { useReverifiedRequest } from "./useReverifiedRequest";
import AgreementLink, { useShownRevisions } from "./AgreementLink";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { useAccount } from "@/context/AccountContext";
import W9Certification from "./W9Certification";
import { MARITAL_STATUSES, US_STATES, type MaritalStatus } from "@/lib/kyc";
import { MARITAL_LABELS } from "./FormFields";
import type { Account, AccountConfigurations, BrokerAccount } from "@/lib/types";

// Margin needs this much equity; below it buying power is 1x (the simulator's MIN_MARGIN_EQUITY, Alpaca's rule)
const MIN_MARGIN_EQUITY = 2000;

const STATUS_LABELS: Record<string, string> = { ACTIVE: "Active", ACCOUNT_UPDATED: "Active, updated details under review" };

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="settings-section">
        <h2 className="panel-title">{title}</h2>
        {children}
    </section>
);

// Account settings: the account's details, contact and employment (an edited address, name or employer is reviewed), marital status,
// the trusted contact, trading configurations, the upgrade to margin, the W-9 certification, and closing the account
const AccountSettings = () => {
    const { active, refreshAccounts } = useBrokerAccount();
    const { refreshAccount } = useAccount();
    const request = useReverifiedRequest();
    const shownRevisions = useShownRevisions();
    const [account, setAccount] = useState<BrokerAccount | null>(null);
    const [configurations, setConfigurations] = useState<AccountConfigurations | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The section that last saved, and a message for it
    const [notice, setNotice] = useState<{ section: string; text: string; error?: boolean } | null>(null);
    const [contact, setContact] = useState({ email_address: "", phone_number: "", street: "", street2: "", city: "", state: "", postal_code: "" });
    const [employment, setEmployment] = useState({ employment_status: "", employer_name: "", employment_position: "" });
    const [maritalStatus, setMaritalStatus] = useState<MaritalStatus | "">("");
    const [trusted, setTrusted] = useState({ given_name: "", family_name: "", email_address: "", phone_number: "" });
    const [acceptMargin, setAcceptMargin] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);

    const id = active?.accountId;
    const load = useCallback(async () => {
        if (!id) return;
        try {
            const [accountResponse, configurationsResponse] = await Promise.all([
                axios.get<BrokerAccount>(`/api/accounts/${id}`),
                axios.get<AccountConfigurations>(`/api/accounts/${id}/configurations`)
            ]);
            const loaded = accountResponse.data;
            setAccount(loaded);
            setConfigurations(configurationsResponse.data);
            const [street = "", street2 = ""] = loaded.contact?.street_address ?? [];
            setContact({
                email_address: loaded.contact?.email_address ?? "", phone_number: loaded.contact?.phone_number ?? "", street, street2,
                city: loaded.contact?.city ?? "", state: loaded.contact?.state ?? "", postal_code: loaded.contact?.postal_code ?? ""
            });
            setEmployment({
                employment_status: loaded.disclosures?.employment_status ?? "", employer_name: loaded.disclosures?.employer_name ?? "",
                employment_position: loaded.disclosures?.employment_position ?? ""
            });
            setMaritalStatus((loaded.identity?.marital_status ?? "") as MaritalStatus | "");
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
    const patchAccount = (body: object) => request<BrokerAccount>({ method: "patch", url: `/api/accounts/${id}`, data: body });
    // An edited address, name or employer puts the account under review
    const reviewNotice = ({ data }: { data: BrokerAccount }) => data.status === "ACCOUNT_UPDATED"
        ? "Saved. Your new details are being reviewed; withdrawals resume once they're approved."
        : "Saved.";
    const patchConfigurations = (body: AccountConfigurations) => request({ method: "patch", url: `/api/accounts/${id}/configurations`, data: body });
    const noticeFor = (section: string) => notice?.section === section && notice.text && <p className={notice.error ? "text-danger" : "text-success"}>{notice.text}</p>;

    if (error) return <p className="text-danger text-center mt-5">Couldn&apos;t load your account: {error}</p>;
    if (!account || !configurations || !active) return <p className="text-center mt-5">Loading...</p>;

    const agreements = (account.agreements ?? []).map(({ agreement }) => agreement);
    const isMargin = agreements.includes("margin_agreement");
    const isIra = account.account_type === "ira";

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
    const onMaritalStatus = (event: FormEvent) => {
        event.preventDefault();
        if (maritalStatus) save("marital", () => patchAccount({ identity: { marital_status: maritalStatus } }), "Saved.");
    };
    const onTrusted = (event: FormEvent) => {
        event.preventDefault();
        save("trusted", () => patchAccount({ trusted_contact: trusted }), "Saved.");
    };
    // Signs the margin agreement and turns shorting on, leaving the multiplier unset so the account gets the broker's limit (on
    // Alpaca, 4x intraday and 2x overnight once it enables margin for the account; setting 2 would give up the 4x). Then says what the
    // account got: margin needs $2,000 of equity, and Alpaca enables it per account, so a broker that hasn't keeps it at 1x (or
    // refuses the change, 422) with the agreement signed
    const onUpgradeMargin = () => save("margin", async () => {
        await patchAccount({ agreements: [{ agreement: "margin_agreement" }], revisions: shownRevisions(["margin_agreement"]) });
        try {
            await patchConfigurations({ no_shorting: false });
        } catch (error) {
            if (!(axios.isAxiosError(error) && error.response?.status === 422)) throw error;
            logError(error);
            return null;
        }
        const { data } = await axios.get<Account>("/api/account");
        refreshAccount();
        return data;
    }, upgraded => {
        const notEnabled = "The margin agreement is signed, but the broker hasn't enabled margin for this account yet, so it stays at 1× until it does.";
        if (!upgraded) return notEnabled;
        if (upgraded.equity < MIN_MARGIN_EQUITY) return "Your account is now a margin account. Borrowing and short selling start once your equity reaches $2,000; until then buying power is 1×.";
        return upgraded.multiplier > 1 ? `Your account is now a margin account, at ${upgraded.multiplier}× buying power.` : notEnabled;
    });
    const onClose = () => save("close", async () => {
        await request({ method: "post", url: `/api/accounts/${id}/close` });
    }, "Your account is closed.");

    return (
        <main className="transfer-container settings mt-5">
            <h1 className="transfer-title">Settings</h1>

            <Section title="Account">
                <dl className="onboarding-review">
                    <dt>Account number</dt><dd>{account.account_number}</dd>
                    <dt>Status</dt><dd>{STATUS_LABELS[account.status] ?? account.status}</dd>
                    <dt>Type</dt><dd>{isMargin ? "Margin" : "Cash"} account</dd>
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

            <Section title="Marital status">
                <form className="transfer-fields" onSubmit={onMaritalStatus}>
                    <p className="text-muted mb-0">For a retirement account, it tells whether your spouse&apos;s consent may be needed for its beneficiaries.</p>
                    <select className="form-control" aria-label="Marital status" value={maritalStatus} onChange={event => setMaritalStatus(event.target.value as MaritalStatus | "")}>
                        <option value="" disabled>Choose…</option>
                        {MARITAL_STATUSES.map(status => <option key={status} value={status}>{MARITAL_LABELS[status]}</option>)}
                    </select>
                    {noticeFor("marital")}
                    <button type="submit" className="btn btn-dark" disabled={!maritalStatus || maritalStatus === account.identity?.marital_status}>Save marital status</button>
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
                                <select className="form-control" value={configurations.max_margin_multiplier ?? ""} onChange={event => save("trading", () => patchConfigurations({ max_margin_multiplier: event.target.value }), "Saved.")}>
                                    {/* Unset follows the broker's limit; the API can't unset it again, and choosing 4× does the same */}
                                    <option value="" disabled>The broker&apos;s limit (up to 4× intraday, 2× overnight)</option>
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
                        I&apos;ve read and accept the <AgreementLink name="margin_agreement">margin agreement</AgreementLink>
                    </label>
                    <button type="button" className="btn btn-dark" disabled={!acceptMargin} onClick={onUpgradeMargin}>Upgrade to margin</button>
                </Section>
            )}

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
