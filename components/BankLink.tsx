"use client";

import { useState, type FormEvent } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { accountNumberValid, digitsOnly, routingValid } from "@/lib/payments";
import type { AchRelationship } from "@/lib/types";

const STATUS_LABELS: Record<string, string> = { QUEUED: "Verifying…", APPROVED: "Linked", REJECTED: "Not verified", PENDING: "Pending", CANCEL_REQUESTED: "Removing…" };

// Plaid Link's browser script (plaid.com/docs/link/web), loaded only when a bank is linked through Plaid
const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
interface PlaidHandler {
    open: () => void;
    destroy: () => void;
}
interface PlaidLink {
    create: (config: {
        token: string;
        onSuccess: (publicToken: string, metadata: { accounts?: { id: string }[]; account_id?: string | null }) => void;
        onExit: (error: { display_message?: string | null; error_message?: string } | null) => void;
    }) => PlaidHandler;
}
const loadPlaid = () => new Promise<PlaidLink>((resolve, reject) => {
    const loaded = (window as unknown as { Plaid?: PlaidLink }).Plaid;
    if (loaded) return resolve(loaded);
    const script = document.createElement("script");
    script.src = PLAID_SCRIPT;
    script.async = true;
    script.onload = () => {
        const plaid = (window as unknown as { Plaid?: PlaidLink }).Plaid;
        if (plaid) resolve(plaid);
        else reject(new Error("Plaid Link didn't load"));
    };
    script.onerror = () => reject(new Error("Plaid Link couldn't be loaded"));
    document.head.appendChild(script);
});

// The account's bank link (ACH relationship): its status with a Remove button, or a way to link one (the owner must be the account
// holder): through Plaid Link when the broker offers it (plaid; the app never sees the bank's numbers), else, or as well, by routing
// and account number. A rejected link shows why, with the form to try another account.
const BankLink = ({ accountId, holderName, relationships, onChanged, plaid = false, simulated = true }: {
    accountId: string; holderName: string; relationships: AchRelationship[]; onChanged: () => Promise<void>; plaid?: boolean; simulated?: boolean;
}) => {
    const [form, setForm] = useState({ owner: holderName, type: "CHECKING" as "CHECKING" | "SAVINGS", routing: "", account: "", confirm: "", nickname: "" });
    const [showErrors, setShowErrors] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const active = relationships.find(({ status }) => status === "QUEUED" || status === "APPROVED" || status === "PENDING");
    const rejected = relationships.find(({ status }) => status === "REJECTED");
    const errors: Record<string, string> = {};
    if (!form.owner.trim()) errors.owner = "Enter the bank account's owner";
    if (!routingValid(form.routing)) errors.routing = "Enter a valid 9-digit routing number";
    if (!accountNumberValid(form.account)) errors.account = "Enter a 4- to 17-digit account number";
    else if (form.confirm !== form.account) errors.confirm = "The account numbers don't match";

    const link = async (event: FormEvent) => {
        event.preventDefault();
        if (Object.keys(errors).length > 0) {
            setShowErrors(true);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await axios.post(`/api/accounts/${accountId}/ach`, {
                account_owner_name: form.owner.trim(), bank_account_type: form.type, bank_account_number: form.account,
                bank_routing_number: form.routing, ...(form.nickname.trim() ? { nickname: form.nickname.trim() } : {})
            });
            setForm({ ...form, routing: "", account: "", confirm: "" });
            setShowErrors(false);
            await onChanged();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    // Opens Plaid Link with a link token from the server, then links the account picked with its public token
    const linkWithPlaid = async () => {
        setBusy(true);
        setError(null);
        try {
            const [{ data: { linkToken } }, Plaid] = await Promise.all([axios.post<{ linkToken: string }>("/api/plaid/link-token"), loadPlaid()]);
            const handler = Plaid.create({
                token: linkToken,
                onSuccess: async (publicToken, metadata) => {
                    try {
                        await axios.post(`/api/accounts/${accountId}/ach`, { plaid: { public_token: publicToken, account_id: metadata.accounts?.[0]?.id ?? metadata.account_id } });
                        await onChanged();
                    } catch (error) {
                        logError(error);
                        setError(apiErrorMessage(error));
                    } finally {
                        handler.destroy();
                        setBusy(false);
                    }
                },
                onExit: exitError => {
                    if (exitError) setError(exitError.display_message || exitError.error_message || "Plaid Link closed");
                    handler.destroy();
                    setBusy(false);
                }
            });
            handler.open();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
            setBusy(false);
        }
    };

    const remove = async (relationshipId: string) => {
        setBusy(true);
        setError(null);
        try {
            await axios.delete(`/api/accounts/${accountId}/ach/${relationshipId}`);
            await onChanged();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    if (active) {
        return (
            <div className="bank-link">
                <div>
                    <strong>{active.nickname ?? (active.bank_account_type === "CHECKING" ? "Checking" : "Savings")}</strong> {active.bank_account_number}
                    <span className="text-muted"> · routing {active.bank_routing_number} · {active.account_owner_name}</span>
                </div>
                <div>
                    <span className={`transfer-status ${active.status.toLowerCase()}`}>{STATUS_LABELS[active.status] ?? active.status}</span>
                    <button type="button" className="btn btn-sm btn-link text-muted" disabled={busy} onClick={() => remove(active.id)}>Remove</button>
                </div>
                {error && <p className="text-danger mb-0">{error}</p>}
            </div>
        );
    }

    const shown = (field: string) => showErrors ? errors[field] : undefined;
    return (
        <form className="transfer-fields" onSubmit={link} noValidate>
            {rejected && <p className="text-danger mb-0">Your last bank ({rejected.bank_account_number}) couldn&apos;t be linked: {(rejected as AchRelationship & { reason?: string }).reason ?? "not verified"}.</p>}
            {plaid && (
                <>
                    <button type="button" className="btn btn-dark" disabled={busy} onClick={linkWithPlaid}>{busy ? "Linking…" : "Link your bank with Plaid"}</button>
                    <small className="text-muted">Or enter its routing and account numbers:</small>
                </>
            )}
            <label className="transfer-field">
                <span className="transfer-field-label">Account owner</span>
                <input className="form-control" value={form.owner} onChange={event => setForm({ ...form, owner: event.target.value })} />
                <small className="text-muted">It must be in your name, as on this brokerage account</small>
                {shown("owner") && <small className="text-danger">{shown("owner")}</small>}
            </label>
            <div className="method-tiles" role="radiogroup" aria-label="Account type">
                {(["CHECKING", "SAVINGS"] as const).map(type => (
                    <button key={type} type="button" role="radio" aria-checked={form.type === type} className={`method-tile${form.type === type ? " active" : ""}`}
                        onClick={() => setForm({ ...form, type })}>{type === "CHECKING" ? "Checking" : "Savings"}</button>
                ))}
            </div>
            <label className="transfer-field">
                <span className="transfer-field-label">Routing number</span>
                <input className="form-control" inputMode="numeric" autoComplete="off" maxLength={9} value={form.routing} onChange={event => setForm({ ...form, routing: digitsOnly(event.target.value) })} />
                {shown("routing") && <small className="text-danger">{shown("routing")}</small>}
            </label>
            <div className="transfer-row">
                <label className="transfer-field">
                    <span className="transfer-field-label">Account number</span>
                    <input className="form-control" inputMode="numeric" autoComplete="off" maxLength={17} value={form.account} onChange={event => setForm({ ...form, account: digitsOnly(event.target.value) })} />
                    {shown("account") && <small className="text-danger">{shown("account")}</small>}
                </label>
                <label className="transfer-field">
                    <span className="transfer-field-label">Confirm account number</span>
                    <input className="form-control" inputMode="numeric" autoComplete="off" maxLength={17} value={form.confirm} onChange={event => setForm({ ...form, confirm: digitsOnly(event.target.value) })} />
                    {shown("confirm") && <small className="text-danger">{shown("confirm")}</small>}
                </label>
            </div>
            <label className="transfer-field">
                <span className="transfer-field-label">Nickname (optional)</span>
                <input className="form-control" maxLength={40} value={form.nickname} onChange={event => setForm({ ...form, nickname: event.target.value })} />
            </label>
            {error && <p className="text-danger mb-0">{error}</p>}
            <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Linking…" : "Link bank account"}</button>
            {simulated ? (
                <small className="text-muted">
                    Simulator: use test numbers, such as routing 011000015 and any account number; one ending in 0000 fails verification.
                    Only its last 4 digits are kept.
                </small>
            ) : <small className="text-muted">Only its last 4 digits are kept here.</small>}
        </form>
    );
};

export default BankLink;
