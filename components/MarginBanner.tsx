"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useAccount } from "@/context/AccountContext";
import { formatCurrency, formatShares } from "@/lib/orders";

// The newest buy-in trade each user has dismissed, by its time (fill IDs start with it). Browser storage can be unavailable (private
// windows, or the server render), so failures are ignored.
const dismissedKey = (userId: string | null | undefined) => `dismissedLiquidationAt:${userId}`;
const readDismissed = (userId: string | null | undefined) => {
    try {
        return localStorage.getItem(dismissedKey(userId)) ?? "";
    } catch {
        return "";
    }
};

// Under the header: a margin call warning while there's a collateral shortfall, and a notice of automatic buy-ins from the past week
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
            {account.collateralShortfall > 0 && (
                <div className="margin-banner danger" role="alert">
                    <span>
                        <strong>Margin call: {formatCurrency(account.collateralShortfall)} collateral shortfall.</strong>{" "}
                        {account.shortLiability > 0
                            ? <>Shorts need 150% of their value ({formatCurrency(account.collateralRequirement)}) in cash, and you have {formatCurrency(account.totalCash)}. </>
                            : <>Your cash balance is {formatCurrency(account.totalCash)}. </>}
                        Until it&apos;s fixed, only covers, sales and deposits are allowed. <Link href="/deposit">Deposit</Link> or close positions on
                        the <Link href="/portfolio">Portfolio</Link>.
                        {account.shortLiability > 0 && " Below 130%, shorts are bought in automatically."}
                    </span>
                </div>
            )}
            {liquidations.length > 0 && (
                <div className="margin-banner warning" role="status">
                    <span>
                        <strong>Automatic buy-in to restore short collateral:</strong>{" "}
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
