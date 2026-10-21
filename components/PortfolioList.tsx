"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import PortfolioRow, { type Status } from "./PortfolioRow";
import { apiErrorMessage, logError } from "@/lib/apiError";
import MarketStatusBadge from "./MarketStatusBadge";
import { formatCurrency, roundShares } from "@/lib/orders";
import type { MarketStatus } from "@/lib/marketHours";
import type { PortfolioPosition } from "@/lib/types";

const PortfolioList = () => {
    const [positions, setPositions] = useState<PortfolioPosition[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const [market, setMarket] = useState<MarketStatus | null>(null);

    useEffect(() => {
        const getPortfolio = async () => {
            try {
                const response = await axios.get<PortfolioPosition[]>("/api/portfolio");
                setPositions(response.data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getPortfolio();
        // Only used to disable the trade buttons while the market is closed; the server checks too
        axios.get<MarketStatus>("/api/market").then(response => setMarket(response.data), logError);
    }, []);

    // Update the row in place rather than refetching, which would cost one Alpha Vantage call per position
    const onTrade = (ticker: string, delta: number) => {
        setPositions(prev => (prev ?? [])
            .map(position => position.ticker === ticker ? { ...position, quantity: roundShares(position.quantity + delta) } : position)
            .filter(position => position.quantity !== 0));
    };

    if (error) {
        return <p className="text-danger mt-5">Couldn&apos;t load portfolio: {error}</p>;
    }
    if (positions === null) {
        return <p className="mt-5">Loading...</p>;
    }
    if (positions.length === 0) {
        return <p className="mt-5">No open positions.</p>;
    }

    const priced = positions.filter((position): position is PortfolioPosition & { price: number } => position.price !== null);
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
            <MarketStatusBadge status={market} />
            {priced.length < positions.length && (
                <p className="text-muted">Positions without a current price aren&apos;t included in the total.</p>
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
                            <PortfolioRow key={position.ticker} position={position} onTrade={onTrade} setStatus={setStatus} marketOpen={market?.open ?? true} />
                        ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    );
};

export default PortfolioList;
