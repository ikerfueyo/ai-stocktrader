"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { logError } from "@/lib/apiError";
import type { CorporateActionEntry } from "@/lib/types";

const LABELS: Record<CorporateActionEntry["type"], string> = {
    SPLIT: "Split", DIVIDEND: "Dividend", STOCK_DIVIDEND: "Stock dividend", CASH_MERGER: "Cash merger", STOCK_MERGER: "Stock merger",
    MIXED_MERGER: "Stock and cash merger", SPINOFF: "Spinoff", NAME_CHANGE: "Symbol change", WORTHLESS: "Worthless removal"
};

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// A stock's corporate actions from the past year and those ahead (/api/quote/[ticker]/corporate-actions), with what each does to
// positions and open orders. Hidden when there are none.
const CorporateActions = ({ ticker }: { ticker: string }) => {
    const [actions, setActions] = useState<CorporateActionEntry[]>([]);

    useEffect(() => {
        const getActions = async () => {
            setActions([]);
            try {
                setActions((await axios.get<CorporateActionEntry[]>(`/api/quote/${ticker}/corporate-actions`)).data);
            } catch (error) {
                logError(error);
            }
        };
        getActions();
    }, [ticker]);

    if (actions.length === 0) return null;
    const now = today();
    return (
        <section className="earnings-details">
            <h2 className="panel-title">Corporate actions</h2>
            <table className="table table-sm">
                <thead>
                    <tr><th scope="col">Effective</th><th scope="col">Action</th><th scope="col">Details</th></tr>
                </thead>
                <tbody>
                    {actions.map(action => (
                        <tr key={`${action.ticker}-${action.type}-${action.exDate}`}>
                            <td>{action.exDate}{action.exDate > now && <span className="fill-detail">upcoming</span>}</td>
                            <td>{LABELS[action.type]}</td>
                            <td>
                                {action.description}
                                {action.paymentDate && action.type === "DIVIDEND" && <span className="fill-detail">paid {action.paymentDate}</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="text-muted small">
                Splits, stock dividends and mergers change positions on their effective date: open GTC buy limits and sell stops are adjusted for
                splits and dividends, and other open orders placed before are cancelled, as brokers handle them.
            </p>
        </section>
    );
};

export default CorporateActions;
