"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { formatCurrency, formatShares } from "@/lib/orders";
import type { TaxLot } from "@/lib/types";

// A position's open tax lots (/api/accounts/[id]/lots?symbol=), oldest first, the order sales close them in (FIFO): when each was
// acquired, its shares, price and cost basis, and whether selling it now would be a long-term gain or loss (held over a year)
const PositionLots = ({ ticker }: { ticker: string }) => {
    const { active } = useBrokerAccount();
    const [lots, setLots] = useState<TaxLot[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        const getLots = async () => {
            try {
                setLots((await axios.get<TaxLot[]>(`/api/accounts/${active.accountId}/lots?symbol=${encodeURIComponent(ticker)}`)).data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getLots();
    }, [active, ticker]);

    if (error) return <p className="text-danger">Couldn&apos;t load the tax lots: {error}</p>;
    if (!lots) return <p>Loading...</p>;
    if (lots.length === 0) return <p className="text-muted">No open lots.</p>;
    return (
        <table className="table table-sm lots-table">
            <caption>Tax lots, oldest first: sales close them in this order (FIFO)</caption>
            <thead>
                <tr><th scope="col">Acquired</th><th scope="col">Shares</th><th scope="col">{lots[0].side === "short" ? "Sold at" : "Cost per share"}</th><th scope="col">Cost basis</th><th scope="col">Holding period</th></tr>
            </thead>
            <tbody>
                {lots.map(lot => (
                    <tr key={lot.id}>
                        <td>{new Date(lot.acquiredAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</td>
                        <td>{formatShares(lot.qty)}{lot.qty !== lot.originalQty && <span className="text-muted"> of {formatShares(lot.originalQty)}</span>}</td>
                        <td>{formatCurrency(lot.price)}</td>
                        <td>{formatCurrency(lot.costBasis)}</td>
                        <td>{lot.side === "short" ? "Short sale" : lot.longTerm ? "Long-term" : "Short-term"}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

export default PositionLots;
