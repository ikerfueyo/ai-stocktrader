"use client";

import { useState } from "react";
import Link from "next/link";
import axios from "axios";
import BankLink from "./BankLink";
import { IN_PROGRESS, useFunding } from "./useFunding";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency } from "@/lib/orders";
import { formatEastern } from "@/lib/marketHours";

const STATUS_LABELS: Record<string, string> = {
    QUEUED: "Requested", APPROVAL_PENDING: "Pending approval", PENDING: "Pending", SENT_TO_CLEARING: "In transit", APPROVED: "Approved",
    COMPLETE: "Complete", CANCELED: "Canceled", REJECTED: "Rejected", RETURNED: "Returned"
};

// The bank link, the banks wires go to, and every transfer with its status: what's on its way and when it's expected, what
// completed, and what came back. A transfer can be canceled while it's still requested (before the ACH batch or the wire goes).
const TransfersPage = () => {
    const { refreshAccount } = useAccount();
    const { accountId, relationships, banks, transfers, holderName, terms, error, reload } = useFunding();
    const [actionError, setActionError] = useState<string | null>(null);

    const act = async (request: () => Promise<unknown>) => {
        setActionError(null);
        try {
            await request();
            await Promise.all([reload(), refreshAccount()]);
        } catch (error) {
            logError(error);
            setActionError(apiErrorMessage(error));
        }
    };

    return (
        <main className="transfer-container transfers-page mt-5">
            <h1 className="transfer-title">Transfers</h1>
            <p className="text-center">
                <Link href="/deposit" className="btn btn-dark mr-2">Deposit</Link>
                <Link href="/withdraw" className="btn btn-outline-dark">Withdraw</Link>
            </p>
            {error && <p className="text-danger">Couldn&apos;t load your transfers: {error}</p>}
            {actionError && <p className="text-danger">{actionError}</p>}

            <section className="settings-section">
                <h2 className="panel-title">Linked bank (ACH)</h2>
                {accountId && relationships !== null ? (
                    <BankLink accountId={accountId} holderName={holderName} relationships={relationships} onChanged={reload} plaid={terms?.plaid} simulated={terms?.simulated ?? true} />
                ) : <p>Loading...</p>}
            </section>

            {banks.length > 0 && (
                <section className="settings-section">
                    <h2 className="panel-title">Wire recipients</h2>
                    {banks.map(bank => (
                        <div key={bank.id} className="bank-link">
                            <div><strong>{bank.name}</strong> {bank.account_number}<span className="text-muted"> · routing {bank.bank_code}</span></div>
                            <button type="button" className="btn btn-sm btn-link text-muted" onClick={() => act(() => axios.delete(`/api/accounts/${accountId}/banks/${bank.id}`))}>Remove</button>
                        </div>
                    ))}
                </section>
            )}

            <section className="settings-section">
                <h2 className="panel-title">History</h2>
                {transfers.length === 0 ? (
                    <p className="text-muted">No transfers yet.</p>
                ) : (
                    <table className="table table-sm transfers-table">
                        <thead>
                            <tr><th scope="col">Requested</th><th scope="col">Transfer</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col" aria-label="Actions" /></tr>
                        </thead>
                        <tbody>
                            {transfers.map(transfer => {
                                const instant = Number(transfer.instant_amount ?? 0);
                                const fee = Number(transfer.fee ?? 0);
                                const inProgress = IN_PROGRESS.includes(transfer.status);
                                return (
                                    <tr key={transfer.id}>
                                        <td>{formatEastern(transfer.created_at, { withDay: true })}</td>
                                        <td>{transfer.type === "ach" ? "ACH" : "Wire"} {transfer.direction === "INCOMING" ? "deposit" : "withdrawal"}</td>
                                        <td className={transfer.direction === "INCOMING" ? "price-change positive" : "price-change negative"}>
                                            {transfer.direction === "INCOMING" ? "+" : "−"}{formatCurrency(Number(transfer.amount))}
                                            {fee > 0 && <small className="text-muted d-block">+{formatCurrency(fee)} fee</small>}
                                            {instant > 0 && inProgress && <small className="text-muted d-block">{formatCurrency(instant)} available now</small>}
                                        </td>
                                        <td>
                                            <span className={`transfer-status ${transfer.status.toLowerCase()}`}>{STATUS_LABELS[transfer.status] ?? transfer.status}</span>
                                            {inProgress && transfer.expires_at && <small className="text-muted d-block">expected {formatEastern(transfer.expires_at, { withDay: true })}</small>}
                                            {transfer.reason && !inProgress && transfer.status !== "COMPLETE" && <small className="text-muted d-block">{transfer.reason}</small>}
                                        </td>
                                        <td>
                                            {transfer.status === "QUEUED" && (
                                                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => act(() => axios.delete(`/api/accounts/${accountId}/transfers/${transfer.id}`))}>Cancel</button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </section>
        </main>
    );
};

export default TransfersPage;
