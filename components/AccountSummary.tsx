"use client";

import { useAccount } from "@/context/AccountContext";
import { formatCurrency, formatSigned } from "@/lib/orders";

// Available cash (with any short collateral held back from it), equity and unrealized P&L, shown in the center of the header
const AccountSummary = () => {
    const { account, error } = useAccount();

    if (error) {
        return (
            <div className="header-center">
                <span className="text-danger account-error" title={error}>Couldn&apos;t load account: {error}</span>
            </div>
        );
    }

    // Positions whose price couldn't be fetched are valued at their last known price, or their cost
    const missing = account?.missingPrices ?? [];
    const partial = missing.length > 0 && (
        <span className="account-partial" title={`${missing.join(", ")} valued at a last known price or cost (no current price)`}>*</span>
    );
    const pnlClass = account ? (account.unrealizedPnl >= 0 ? "positive" : "negative") : "";

    return (
        <div className="header-center">
            <div className="account-stat">
                <span className="account-label">Available</span>
                <span className="account-value">{account ? formatCurrency(account.availableCash) : "…"}</span>
                {account && account.restrictedCash > 0 && (
                    <span className="account-restricted"
                        title={`Held as short collateral: 150% of your ${formatCurrency(account.shortLiability)} short liability. Total cash: ${formatCurrency(account.totalCash)}.`}>
                        +{formatCurrency(account.restrictedCash)} restricted
                    </span>
                )}
            </div>
            <div className="account-stat">
                <span className="account-label">Equity</span>
                <span className="account-value">{account ? formatCurrency(account.equity) : "…"}{partial}</span>
            </div>
            <div className="account-stat">
                <span className="account-label">Unrealized P&amp;L</span>
                <span className={`account-value price-change ${pnlClass}`}>{account ? formatSigned(account.unrealizedPnl) : "…"}{partial}</span>
            </div>
        </div>
    );
};

export default AccountSummary;
