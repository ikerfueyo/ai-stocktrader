"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { formatCurrency, formatShares } from "@/lib/orders";
import type { BrokerActivity } from "@/lib/types";

const FILTERS = [
    { label: "All", types: "" },
    { label: "Trades", types: "FILL" },
    { label: "Deposits & withdrawals", types: "CSD,CSW" },
    { label: "Fees", types: "FEE" },
    { label: "Interest", types: "INT" },
    { label: "Withholding", types: "WH" },
    { label: "Dividends", types: "DIV" },
    { label: "Corporate actions", types: "SPLIT,MA,SPIN,REORG,CIL" }
];
const TYPE_LABELS: Record<string, string> = { FILL: "Trade", CSD: "Deposit", CSW: "Withdrawal", FEE: "Fee", DIV: "Dividend", SPLIT: "Split", INT: "Interest", MA: "Merger", SPIN: "Spinoff", REORG: "Removal", CIL: "Cash in lieu", WH: "Withholding" };

// The fields the feed shows, from either a trade activity or a non-trade one
const describe = (activity: BrokerActivity) => {
    const fill = activity as BrokerActivity & { transaction_time?: string; side?: string; qty?: string; price?: string; symbol?: string };
    const other = activity as BrokerActivity & { created_at?: string; date?: string; description?: string; net_amount?: string };
    if (activity.activity_type === "FILL") {
        const amount = Number(fill.qty) * Number(fill.price);
        return {
            date: fill.transaction_time ?? "", type: TYPE_LABELS.FILL,
            details: `${fill.side === "buy" ? "Bought" : "Sold"} ${formatShares(Number(fill.qty))} ${fill.symbol} at ${formatCurrency(Number(fill.price))}`,
            amount: fill.side === "buy" ? -amount : amount
        };
    }
    return { date: other.created_at ?? other.date ?? "", type: TYPE_LABELS[activity.activity_type] ?? activity.activity_type, details: other.description ?? "", amount: Number(other.net_amount ?? 0) };
};

const csvCell = (value: string | number) => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);

// Every activity in the account's ledger, newest first (/api/accounts/[id]/activities): trades, deposits and withdrawals, fees,
// dividends and splits, filtered by kind, with a CSV export of what's shown
const ActivityFeed = () => {
    const { active } = useBrokerAccount();
    const [types, setTypes] = useState("");
    const [activities, setActivities] = useState<BrokerActivity[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        const getActivities = async () => {
            setActivities(null);
            try {
                const query = new URLSearchParams({ page_size: "1000", ...(types ? { types } : {}) });
                setActivities((await axios.get<BrokerActivity[]>(`/api/accounts/${active.accountId}/activities?${query}`)).data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getActivities();
    }, [active, types]);

    const rows = (activities ?? []).map(activity => ({ id: activity.id, ...describe(activity) }));
    const exportCsv = () => {
        const lines = [["Date", "Type", "Details", "Amount"], ...rows.map(({ date, type, details, amount }) => [date, type, details, amount.toFixed(2)])];
        const blob = new Blob([lines.map(line => line.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `activity-${active?.accountNumber ?? "account"}-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    return (
        <div className="mt-3">
            <div className="activity-toolbar">
                <select className="form-control form-control-sm" value={types} onChange={event => setTypes(event.target.value)} aria-label="Activity type">
                    {FILTERS.map(({ label, types: value }) => <option key={label} value={value}>{label}</option>)}
                </select>
                <button type="button" className="btn btn-sm btn-outline-dark" disabled={rows.length === 0} onClick={exportCsv}>Export CSV</button>
            </div>
            {error ? <p className="text-danger">Couldn&apos;t load the activity: {error}</p>
                : activities === null ? <p>Loading...</p>
                : rows.length === 0 ? <p className="mt-3">No activity yet.</p>
                : (
                    <div className="table-container mt-2">
                        <table className="table text-center">
                            <thead className="thead-dark">
                                <tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Details</th><th scope="col">Amount</th></tr>
                            </thead>
                            <tbody>
                                {rows.map(({ id, date, type, details, amount }) => (
                                    <tr key={id}>
                                        <td>{date ? new Date(date).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                                        <td>{type}</td>
                                        <td className="text-left">{details}</td>
                                        <td className={amount === 0 ? "" : `price-change ${amount > 0 ? "positive" : "negative"}`}>{amount === 0 ? "—" : `${amount > 0 ? "+" : "−"}${formatCurrency(Math.abs(amount))}`}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
        </div>
    );
};

export default ActivityFeed;
