"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { contractMultiplier } from "@/lib/options";
import axios from "axios";
import PortfolioRow, { type Status } from "./PortfolioRow";
import { apiErrorMessage, logError } from "@/lib/apiError";
import MarketStatusBadge from "./MarketStatusBadge";
import OpenOrders from "./OpenOrders";
import PerformanceChart from "./PerformanceChart";
import MarginPanel from "./MarginPanel";
import { useAccount } from "@/context/AccountContext";
import { formatCurrency, formatSigned, roundShares } from "@/lib/orders";
import type { MarketStatus } from "@/lib/marketHours";
import type { PortfolioPosition } from "@/lib/types";

// Positions as comparable text: each ticker and its shares, in ticker order
const sharesKey = (positions: { ticker: string; quantity: number }[]) =>
    positions.map(({ ticker, quantity }) => `${ticker}:${quantity}`).sort().join(",");

const PortfolioList = () => {
    const [positions, setPositions] = useState<PortfolioPosition[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const [market, setMarket] = useState<MarketStatus | null>(null);
    // Bumped when a closing order is queued, to reload the open orders
    const [ordersVersion, setOrdersVersion] = useState(0);
    const { account } = useAccount();

    const loadPortfolio = useCallback(async () => {
        try {
            const response = await axios.get<PortfolioPosition[]>("/api/portfolio");
            setPositions(response.data);
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        }
    }, []);

    useEffect(() => {
        // loadPortfolio only sets state once its request finishes, not synchronously
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadPortfolio();
    }, [loadPortfolio]);

    // Reload when the account's positions change to something other than the rows shown, such as after a background fill or
    // buy-in. This page's own trades update their rows first, so the account refresh that follows them matches and reloads nothing.
    const shown = useRef<string | null>(null);
    const shownKey = positions ? sharesKey(positions) : null;
    useEffect(() => {
        shown.current = shownKey;
    }, [shownKey]);
    const accountKey = account ? sharesKey(account.positions) : null;
    useEffect(() => {
        if (accountKey !== null && shown.current !== null && accountKey !== shown.current) loadPortfolio();
    }, [accountKey, loadPortfolio]);

    useEffect(() => {
        // Only used to label the trade buttons while the market is closed (orders are queued); the server decides
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
        return (
            <Fragment>
                <PerformanceChart />
                <MarginPanel />
                <p className="mt-5">No open positions.</p>
                <OpenOrders refreshKey={ordersVersion} />
            </Fragment>
        );
    }

    const priced = positions.filter((position): position is PortfolioPosition & { price: number } => position.price !== null);
    const totalGain = priced.reduce((sum, { ticker, price, avgCost, quantity }) => sum + (price - avgCost) * quantity * contractMultiplier(ticker), 0);
    const totalCost = priced.reduce((sum, { ticker, avgCost, quantity }) => sum + avgCost * Math.abs(quantity) * contractMultiplier(ticker), 0);
    const totalPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
    const isPositive = totalGain >= 0;
    // Today's change on the positions held now, against the previous close (signed quantity, so a short gains when the price falls)
    const dayPriced = priced.filter((position): position is typeof position & { previousClose: number } => position.previousClose !== null);
    const dayChange = dayPriced.reduce((sum, { ticker, price, previousClose, quantity }) => sum + (price - previousClose) * quantity * contractMultiplier(ticker), 0);

    return (
        <Fragment>
            <PerformanceChart />
            <MarginPanel />
            <div className="price-container mt-5">
                <span className="current-price">
                    {isPositive ? "+" : "-"}{formatCurrency(Math.abs(totalGain))}
                    <span className="currency">unrealized P/L</span>
                    <span className={`price-change ${isPositive ? "positive" : "negative"}`}>
                        {" "}({isPositive ? "+" : ""}{totalPercent.toFixed(2)}%)
                    </span>
                </span>
            </div>
            <p className="portfolio-stats">
                <span>Today <strong className={`price-change ${dayChange >= 0 ? "positive" : "negative"}`}>{formatSigned(dayChange)}</strong></span>
                {account && <span title="Gains and losses booked on shares sold or covered, against their average cost">Realized P/L <strong>{formatSigned(account.realizedPnl)}</strong></span>}
                {account && account.netDividends !== 0 && <span title="Dividends received on longs, less dividends paid on shorts">Dividends <strong>{formatSigned(account.netDividends)}</strong></span>}
            </p>
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
                            <th scope="col">Today</th>
                            <th scope="col">P/L</th>
                            <th scope="col">Trade</th>
                            <th scope="col">AI</th>
                        </tr>
                    </thead>
                    <tbody>
                        {positions.map(position => (
                            <PortfolioRow key={position.ticker} position={position} onTrade={onTrade} setStatus={setStatus} marketOpen={market?.open ?? true} onQueued={() => setOrdersVersion(v => v + 1)} />
                        ))}
                    </tbody>
                </table>
            </div>
            <OpenOrders refreshKey={ordersVersion} />
        </Fragment>
    );
};

export default PortfolioList;
