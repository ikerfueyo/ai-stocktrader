"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useAccount } from "@/context/AccountContext";
import { formatEastern } from "@/lib/marketHours";
import { formatCurrency, formatShares } from "@/lib/orders";

// The newest liquidation trade each user has dismissed, by its time (fill IDs start with it). Browser storage can be unavailable (private
// windows, or the server render), so failures are ignored.
const dismissedKey = (userId: string | null | undefined) => `dismissedLiquidationAt:${userId}`;
const readDismissed = (userId: string | null | undefined) => {
    try {
        return localStorage.getItem(dismissedKey(userId)) ?? "";
    } catch {
        return "";
    }
};

// Under the header: open margin calls (what's due and by when), liquidation while equity is far below the maintenance requirement,
// and a notice of the past week's liquidations
const MarginBanner = () => {
    const { account } = useAccount();
    const { userId } = useAuth();
    const [dismissedId, setDismissedId] = useState(() => readDismissed(userId));
    if (!account) return null;

    const liquidations = (account.liquidations ?? []).filter(({ date }) => date > dismissedId);
    const onDismiss = () => {
        const newest = liquidations.map(({ date }) => date).sort().at(-1) ?? "";
        setDismissedId(newest);
        try {
            localStorage.setItem(dismissedKey(userId), String(newest));
        } catch {
            // Not remembered across visits, but still hidden for now
        }
    };

    return (
        <>
            {account.marginCalls.map(call => (
                <div key={call.id} className="margin-banner danger" role="alert">
                    <span>
                        <strong>{call.type === "regt" ? "Reg T" : "Maintenance"} margin call: {formatCurrency(call.amount)}, due {formatEastern(call.dueAt, { withDay: true })}.</strong>{" "}
                        {call.type === "regt"
                            ? <>At the {call.date} close your equity was below the 50% initial margin for the positions you opened. </>
                            : <>At the {call.date} close your equity was below the maintenance requirement. </>}
                        Until it&apos;s met, only closing orders and deposits are allowed. <Link href="/deposit">Deposit</Link> or close positions on
                        the <Link href="/portfolio">Portfolio</Link>; otherwise positions are liquidated at the deadline.
                    </span>
                </div>
            ))}
            {account.marginStatus === "liquidation" && (
                <div className="margin-banner danger" role="alert">
                    <span>
                        <strong>Equity is far below the maintenance requirement</strong> ({formatCurrency(account.equity)} against {formatCurrency(account.maintenanceMargin)}): positions
                        are being liquidated during the regular session to protect the account.
                    </span>
                </div>
            )}
            {liquidations.length > 0 && (
                <div className="margin-banner warning" role="status">
                    <span>
                        <strong>Liquidated to meet margin requirements:</strong>{" "}
                        {liquidations.map(({ type, ticker, quantity, price }) => (
                            `${type === "BUY" ? "covered" : "sold"} ${formatShares(quantity)} ${ticker} at ${formatCurrency(price)}`
                        )).join(", ")}.
                    </span>
                    <button type="button" className="margin-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
                </div>
            )}
        </>
    );
};

export default MarginBanner;
