"use client";

import { useState, type FormEvent } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { accountNumberValid, digitsOnly, routingValid } from "@/lib/payments";
import type { AchRelationship } from "@/lib/types";

const STATUS_LABELS: Record<string, string> = { QUEUED: "Verifying…", APPROVED: "Linked", REJECTED: "Not verified", PENDING: "Pending", CANCEL_REQUESTED: "Removing…" };

// The account's bank link (ACH relationship): its status with a Remove button, or a form to link one (the owner must be the account
// holder). A rejected link shows why, with the form to try another account.
const BankLink = ({ accountId, holderName, relationships, onChanged }: {
    accountId: string; holderName: string; relationships: AchRelationship[]; onChanged: () => Promise<void>;
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
            <small className="text-muted">
                Simulator: use test numbers, such as routing 011000015 and any account number; one ending in 0000 fails verification.
                Only its last 4 digits are kept.
            </small>
        </form>
    );
};

export default BankLink;
