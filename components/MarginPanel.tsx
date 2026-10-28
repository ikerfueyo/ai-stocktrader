"use client";

import Link from "next/link";
import { useAccount } from "@/context/AccountContext";
import { formatEastern } from "@/lib/marketHours";
import { formatCurrency } from "@/lib/orders";

// The account's margin on the Portfolio page, as the broker computes it: buying power (now, Reg T overnight, non-marginable) and the
// multiplier in effect, equity and the market values, Reg T initial and maintenance margin and the excess over it, the borrowed cash
// with its rate and the interest accrued this month, whether the account may short, and any open margin call with its deadline
const MarginPanel = () => {
    const { account } = useAccount();
    if (!account) return null;
    const onMargin = account.maxMultiplier > 1;
    const rows: [string, string, string?][] = [
        ["Buying power", formatCurrency(account.buyingPower), account.multiplier > 1 ? `${account.multiplier}x now${account.maxMultiplier === 4 ? " (4x intraday, 2x overnight)" : ""}` : "1x: cash"],
        ["Reg T buying power", formatCurrency(account.regtBuyingPower), account.multiplier > 1 ? "overnight, 2x" : undefined],
        ["Non-marginable buying power", formatCurrency(account.nonMarginableBuyingPower)],
        ["Equity", formatCurrency(account.equity)],
        ["Long market value", formatCurrency(account.longMarketValue)],
        ["Short market value", formatCurrency(account.shortMarketValue)],
        ["Initial margin (Reg T)", formatCurrency(account.initialMargin), "50%, 100% for non-marginable stock"],
        ["Maintenance margin", formatCurrency(account.maintenanceMargin), "the house requirement"],
        ["Excess liquidity", formatCurrency(account.excessLiquidity), "equity above maintenance"],
        ["Borrowed", formatCurrency(account.debitBalance), `${(account.marginRate * 100).toFixed(2)}% a year, charged nightly, posted monthly`],
        ["Interest this month", formatCurrency(account.accruedInterest)]
    ];
    return (
        <section className="margin-panel" aria-label="Margin">
            <h2 className="margin-panel-title">Margin</h2>
            {!onMargin && <p className="text-muted">This is a cash account (1x): no borrowing or shorting. <Link href="/settings">Upgrade to margin</Link> with the margin agreement.</p>}
            {onMargin && account.multiplier === 1 && <p className="text-muted">Margin needs at least $2,000 of equity; until then the account trades at 1x and can&apos;t short.</p>}
            {account.marginCalls.map(call => (
                <p key={call.id} className="text-danger">
                    <strong>{call.type === "regt" ? "Reg T" : "Maintenance"} call: {formatCurrency(call.amount)}</strong>, due {formatEastern(call.dueAt, { withDay: true })}. Deposit or close
                    positions to meet it; otherwise the riskiest positions are liquidated at the deadline.
                </p>
            ))}
            <dl className="margin-panel-grid">
                {rows.map(([label, value, note]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}{note && <span className="fill-detail">{note}</span>}</dd>
                    </div>
                ))}
                <div>
                    <dt>Shorting</dt>
                    <dd>{account.shortingEnabled ? "Allowed" : "Not allowed"}{account.shortingBlockedReason && <span className="fill-detail">{account.shortingBlockedReason}</span>}</dd>
                </div>
            </dl>
        </section>
    );
};

export default MarginPanel;
