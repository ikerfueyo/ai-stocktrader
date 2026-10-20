import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import PortfolioRow from "./PortfolioRow";
import { roundShares } from "../utils/orders";

const formatCurrency = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

const PortfolioList = () => {
    const [positions, setPositions] = useState(null);
    const [error, setError] = useState(null);
    const [status, setStatus] = useState(null);

    const getPortfolio = async () => {
        try {
            const response = await axios.get("/portfolio");
            setPositions(response.data);
        } catch (error) {
            console.error(error.message);
            setError(error.response?.data?.error ?? error.message);
        }
    };

    useEffect(() => {
        getPortfolio();
    }, []);

    // Update the row in place rather than refetching, which would cost one Alpha Vantage call per position
    const onTrade = (ticker, delta) => {
        setPositions(prev => prev
            .map(position => position.ticker === ticker ? { ...position, quantity: roundShares(position.quantity + delta) } : position)
            .filter(position => position.quantity !== 0));
    };

    if (error) {
        return <p className="text-danger mt-5">Couldn't load portfolio: {error}</p>;
    }
    if (positions === null) {
        return <p className="mt-5">Loading...</p>;
    }
    if (positions.length === 0) {
        return <p className="mt-5">No open positions.</p>;
    }

    const priced = positions.filter(position => position.price !== null);
    const totalGain = priced.reduce((sum, { price, avgCost, quantity }) => sum + (price - avgCost) * quantity, 0);
    const totalCost = priced.reduce((sum, { avgCost, quantity }) => sum + avgCost * Math.abs(quantity), 0);
    const totalPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
    const isPositive = totalGain >= 0;

    return (
        <Fragment>
            <div className="price-container mt-5">
                <span className="current-price">
                    {isPositive ? "+" : "-"}{formatCurrency(Math.abs(totalGain))}
                    <span className="currency">unrealized P/L</span>
                    <span className={`price-change ${isPositive ? "positive" : "negative"}`}>
                        {" "}({isPositive ? "+" : ""}{totalPercent.toFixed(2)}%)
                    </span>
                </span>
            </div>
            {priced.length < positions.length && (
                <p className="text-muted">Positions without a current price aren't included in the total.</p>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
            <div className="table-container portfolio-container mt-3">
                <table className="table text-center">
                    <thead className="thead-dark">
                        <tr>
                            <th scope="col">Ticker</th>
                            <th scope="col">Shares</th>
                            <th scope="col">Avg Cost</th>
                            <th scope="col">Price</th>
                            <th scope="col">Market Value</th>
                            <th scope="col">P/L</th>
                            <th scope="col">Trade</th>
                            <th scope="col">AI</th>
                        </tr>
                    </thead>
                    <tbody>
                        {positions.map(position => (
                            <PortfolioRow key={position.ticker} position={position} onTrade={onTrade} setStatus={setStatus} />
                        ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    );
};

export default PortfolioList;
