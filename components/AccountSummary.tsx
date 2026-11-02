"use client";

import { useAccount } from "@/context/AccountContext";
import { formatCurrency, formatSigned } from "@/lib/orders";

// Buying power (with the margin in use and what open orders hold back), equity and unrealized P&L, shown in the center of the header
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
                <span className="account-label" title="What new positions can use: cash at 1x; on margin, (equity - initial margin) × the multiplier">Buying power</span>
                <span className="account-value">{account ? formatCurrency(account.buyingPower) : "…"}</span>
                {account && account.multiplier > 1 && (
                    <span className="account-restricted" title={`Margin at ${account.multiplier}x${account.maxMultiplier === 4 && account.multiplier === 4 ? " intraday (2x overnight)" : ""}. Cash: ${formatCurrency(account.totalCash)}.`}>
                        {account.multiplier}x margin{account.debitBalance > 0 ? ` · ${formatCurrency(account.debitBalance)} borrowed` : ""}
                    </span>
                )}
                {account && account.reservedCash > 0 && (
                    <span className="account-restricted" title="Held back for open orders that would open or add to a position, until they fill or are cancelled">
                        {formatCurrency(account.reservedCash)} held for orders
                    </span>
                )}
                {account && account.unsettledProceeds > 0 && (
                    <span className="account-restricted" title="Sale proceeds that settle the next trading day (T+1): they can be traded with now and withdrawn once settled">
                        {formatCurrency(account.unsettledProceeds)} settling
                    </span>
                )}
                {account && account.pendingTransferOut > 0 && (
                    <span className="account-restricted" title="Withdrawals requested and not yet sent; they're already taken out of your cash">
                        −{formatCurrency(account.pendingTransferOut)} withdrawal pending
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
