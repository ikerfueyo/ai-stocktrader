import React, { Fragment, useEffect, useState } from "react";

const TransactionsList = () => {
    const [transactions, setTransactions] = useState([]);

    const getTransactions = async () => {
        try {
            const response = await fetch("http://localhost:5001/transactions");
            const jsonData = await response.json();
            setTransactions(jsonData);
        } catch (error) {
            console.error(error.message);
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
                        {transactions
                            .slice()
                            .sort((a, b) => new Date(b.date) - new Date(a.date))
                            .map(transaction => (
                            <tr key={transaction.id}>
                                <td>{new Date(transaction.date).toLocaleDateString("en-US")}</td>
                                <td>{transaction.ticker}</td>
                                <td style={{ color: transaction.type === "BUY" ? "green" : "red", fontWeight: "bold" }}>{transaction.type}</td>
                                <td>{formatCurrency(transaction.price)}</td>
                                <td>{transaction.quantity}</td>
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