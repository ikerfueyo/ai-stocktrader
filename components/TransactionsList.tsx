"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, formatPrice, formatShares } from "@/lib/orders";
import type { TransactionRow, TransferRow } from "@/lib/types";

// A trade or a deposit/withdrawal, as one row of the table
type Entry = (TransactionRow & { key: string; isTransfer?: false }) | (TransferRow & { key: string; isTransfer: true });

const TransactionsList = () => {
    // Trades and deposits/withdrawals, newest first
    const [transactions, setTransactions] = useState<Entry[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getTransactions = async () => {
            try {
                const [trades, transfers] = await Promise.all([axios.get<TransactionRow[]>("/api/transactions"), axios.get<TransferRow[]>("/api/transfers")]);
                setTransactions([
                    ...trades.data.map(trade => ({ ...trade, key: `trade-${trade.id}` })),
                    ...transfers.data.map(transfer => ({ ...transfer, key: `transfer-${transfer.id}`, isTransfer: true as const }))
                ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getTransactions();
    }, []);

    if (error) {
        return <p className="text-danger mt-5">Couldn&apos;t load transactions: {error}</p>;
    }

    return (
        <Fragment>
            <div className="table-container mt-5">
                <table className="table text-center">
                    <thead className="thead-dark">
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Ticker / Account</th>
                            <th scope="col">Type</th>
                            <th scope="col">Price</th>
                            <th scope="col">Quantity</th>
                            <th scope="col">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {transactions.map(transaction => (
                            <tr key={transaction.key}>
                                <td>{new Date(transaction.date).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</td>
                                <td>{transaction.isTransfer ? transaction.method : transaction.ticker}</td>
                                <td style={{ color: transaction.type === "BUY" || transaction.type === "DEPOSIT" ? "green" : "red", fontWeight: "bold" }}>
                                    {transaction.type}
                                    {!transaction.isTransfer && transaction.reason === "LIQUIDATION" && (
                                        <span className="liquidation-tag" title="Automatic buy-in to restore short collateral">
                                            {transaction.type === "BUY" ? "buy-in" : "liquidation"}
                                        </span>
                                    )}
                                </td>
                                <td>{transaction.isTransfer ? "—" : formatPrice(transaction.price)}</td>
                                <td>{transaction.isTransfer ? "—" : formatShares(transaction.quantity)}</td>
                                <td>{formatCurrency(transaction.isTransfer ? transaction.amount : transaction.total)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    )
};

export default TransactionsList;
