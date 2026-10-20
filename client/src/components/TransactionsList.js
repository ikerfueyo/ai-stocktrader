import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import { formatShares } from "../utils/orders";

const TransactionsList = () => {
    const [transactions, setTransactions] = useState([]);
    const [error, setError] = useState(null);

    const getTransactions = async () => {
        try {
            const response = await axios.get("/transactions");
            setTransactions(response.data);
        } catch (error) {
            console.error(error.message);
            setError(error.response?.data?.error ?? error.message);
        }
    };

    useEffect(() => {
        getTransactions();
    }, []);

    const formatCurrency = (amount) => {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
        }).format(amount);
    };

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
                            <th scope="col">Ticker</th>
                            <th scope="col">Type</th>
                            <th scope="col">Price</th>
                            <th scope="col">Quantity</th>
                            <th scope="col">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {transactions.map(transaction => (
                            <tr key={transaction.id}>
                                <td>{new Date(transaction.date).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</td>
                                <td>{transaction.ticker}</td>
                                <td style={{ color: transaction.type === "BUY" ? "green" : "red", fontWeight: "bold" }}>{transaction.type}</td>
                                <td>{formatCurrency(transaction.price)}</td>
                                <td>{formatShares(transaction.quantity)}</td>
                                <td>{formatCurrency(transaction.total)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    )
};

export default TransactionsList;