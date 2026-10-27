"use client";

import { useEffect, useState, type FormEvent } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { BrokerAccount, BrokerAccountSummary } from "@/lib/types";

const MESSAGES: Record<string, { title: string; body: string }> = {
    SUBMITTED: { title: "Application submitted", body: "We're verifying your identity. This usually takes a few seconds." },
    APPROVED: { title: "Approved", body: "Your account is being opened." },
    APPROVAL_PENDING: { title: "Under review", body: "Your application needs a manual review. We'll open your account as soon as it's approved." },
    ACTION_REQUIRED: { title: "We need a document", body: "We couldn't verify your identity automatically." },
    REJECTED: { title: "Application not approved", body: "We weren't able to open an account with the details given." },
    ACCOUNT_CLOSED: { title: "Account closed", body: "This account is closed." }
};

const ID_TYPES = [
    { subType: "drivers_license", label: "Driver's license" },
    { subType: "passport", label: "Passport" },
    { subType: "state_id", label: "State ID card" }
];

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});

// The application's review status while the account isn't open yet (AccountGate polls it): pending, waiting on a document
// (with an upload form), rejected or closed (with a way to apply again)
const ApplicationStatus = ({ account, onChanged, onReapply }: { account: BrokerAccountSummary; onChanged: () => Promise<void>; onReapply: () => void }) => {
    const [details, setDetails] = useState<BrokerAccount | null>(null);
    const [subType, setSubType] = useState(ID_TYPES[0].subType);
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getDetails = async () => {
            try {
                setDetails((await axios.get<BrokerAccount>(`/api/accounts/${account.accountId}`)).data);
            } catch (error) {
                logError(error);
            }
        };
        getDetails();
    }, [account.accountId, account.status]);

    const upload = async (event: FormEvent) => {
        event.preventDefault();
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            setError("The file must be at most 5 MB");
            return;
        }
        setUploading(true);
        setError(null);
        try {
            await axios.post(`/api/accounts/${account.accountId}/documents`, {
                documents: [{ document_type: "identity_verification", document_sub_type: subType, mime_type: file.type, content: await readBase64(file) }]
            });
            await onChanged();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setUploading(false);
        }
    };

    const message = MESSAGES[account.status] ?? { title: account.status, body: "" };
    const reviewNote = (details as (BrokerAccount & { kyc_results?: { additional_information?: string } }) | null)?.kyc_results?.additional_information;
    const pending = ["SUBMITTED", "APPROVED", "APPROVAL_PENDING"].includes(account.status);

    return (
        <section className="transfer-container application-status mt-5">
            <h1 className="transfer-title">{message.title}</h1>
            <p className="text-center">{message.body}</p>
            {pending && <div className="text-center"><span className="spinner-border spinner-border-sm text-secondary" role="status" aria-label="Checking" /></div>}
            <p className="text-center text-muted">Account number {account.accountNumber}</p>
            {account.status === "ACTION_REQUIRED" && (
                <form className="transfer-fields" onSubmit={upload}>
                    {reviewNote && <p className="text-center">{reviewNote}</p>}
                    <label className="transfer-field">
                        <span className="transfer-field-label">Document</span>
                        <select className="form-control" value={subType} onChange={event => setSubType(event.target.value)}>
                            {ID_TYPES.map(({ subType: value, label }) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </label>
                    <label className="transfer-field">
                        <span className="transfer-field-label">Photo or scan (PDF, PNG or JPEG, up to 5 MB)</span>
                        <input className="form-control" type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => setFile(event.target.files?.[0] ?? null)} />
                        <small className="text-muted">In the simulator only the file&apos;s type and a fingerprint are kept; use a test image.</small>
                    </label>
                    {error && <p className="text-danger">{error}</p>}
                    <button type="submit" className="btn btn-dark" disabled={!file || uploading}>{uploading ? "Uploading…" : "Upload"}</button>
                </form>
            )}
            {(account.status === "REJECTED" || account.status === "ACCOUNT_CLOSED") && (
                <div className="text-center">
                    {reviewNote && <p>{reviewNote}</p>}
                    <button type="button" className="btn btn-dark" onClick={onReapply}>Apply for a new account</button>
                </div>
            )}
        </section>
    );
};

export default ApplicationStatus;
