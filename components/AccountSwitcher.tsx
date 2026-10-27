"use client";

import Link from "next/link";
import axios from "axios";
import { logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { FINAL_ACCOUNT_STATUSES } from "@/lib/accounts";
import type { BrokerAccountKind } from "@/lib/types";

const KIND_LABELS: Record<BrokerAccountKind, string> = { individual: "Individual", traditional_ira: "Traditional IRA", roth_ira: "Roth IRA" };

// The active brokerage account in the header (its kind and last 4 digits, linking to Settings), with a menu to switch when the
// user has more than one open account (POST /api/accounts/active, then a reload so every figure is the new account's)
const AccountSwitcher = () => {
    const { accounts, active } = useBrokerAccount();
    if (!active) return null;
    const open = accounts.filter(({ status }) => !FINAL_ACCOUNT_STATUSES.includes(status));
    const label = (kind: BrokerAccountKind, number: string) => `${KIND_LABELS[kind]} ••${number.slice(-4)}`;

    const switchTo = async (accountId: string) => {
        try {
            await axios.post("/api/accounts/active", { accountId });
            window.location.reload();
        } catch (error) {
            logError(error);
        }
    };

    return (
        <span className="account-switcher mr-3">
            {open.length > 1 ? (
                <select className="form-control form-control-sm" value={active.accountId} aria-label="Account" onChange={event => switchTo(event.target.value)}>
                    {open.map(({ accountId, kind, accountNumber }) => <option key={accountId} value={accountId}>{label(kind, accountNumber)}</option>)}
                </select>
            ) : (
                <Link href="/settings" className="account-chip" title={`Account ${active.accountNumber}${active.status === "ACCOUNT_UPDATED" ? " (updated details under review)" : ""}`}>
                    {label(active.kind, active.accountNumber)}
                </Link>
            )}
        </span>
    );
};

export default AccountSwitcher;
