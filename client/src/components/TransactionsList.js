import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import { formatCurrency, formatShares } from "../utils/orders";

const TransactionsList = () => {
    // Trades and deposits/withdrawals, newest first
    const [transactions, setTransactions] = useState([]);
    const [error, setError] = useState(null);

    const getTransactions = async () => {
        try {
            const [trades, transfers] = await Promise.all([axios.get("/transactions"), axios.get("/transfers")]);
            setTransactions([
                ...trades.data.map(trade => ({ ...trade, key: `trade-${trade.id}` })),
                ...transfers.data.map(transfer => ({ ...transfer, key: `transfer-${transfer.id}`, isTransfer: true }))
            ].sort((a, b) => new Date(b.date) - new Date(a.date)));
        } catch (error) {
            console.error(error.message);
            setError(error.response?.data?.error ?? error.message);
        }
    };

    useEffect(() => {
        getTransactions();
    }, []);

    if (error) {
        return <p className="text-danger mt-5">Couldn't load transactions: {error}</p>;
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
                                    {transaction.reason === "LIQUIDATION" && (
                                        <span className="liquidation-tag" title="Automatic buy-in to restore short collateral">
                                            {transaction.type === "BUY" ? "buy-in" : "liquidation"}
                                        </span>
                                    )}
                                </td>
                                <td>{transaction.isTransfer ? "—" : formatCurrency(transaction.price)}</td>
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