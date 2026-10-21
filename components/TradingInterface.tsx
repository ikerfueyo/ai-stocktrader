"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import Price from "./Price";
import BuySellFunctionality from "./BuySellFunctionality";
import CandlestickChart from "./CandlestickChart";
import AIAnalysis from "./AIAnalysis";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { DailyBar, DailySeries } from "@/lib/types";

const TradingInterface = ({ ticker }: { ticker: string }) => {

    const [data, setData] = useState<Record<string, DailyBar> | null>(null);
    // The latest close, its change from the previous close, and the percent change, each formatted to 2 decimals
    const [price, setPrice] = useState<string | null>(null);
    const [priceChange, setPriceChange] = useState<string | null>(null);
    const [percentChange, setPercentChange] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchData = async () => {
            // Clear the previous ticker's price so it can't be traded while the new one loads
            setPrice(null);
            setData(null);
            setError(null);
            try {
                const response = await axios.get<DailySeries>(`/api/trading/${ticker}`);
                const timeSeries = response.data["Time Series (Daily)"];
                if (timeSeries) {
                    // Close price, price change, and percent change
                    const latestDate = Object.keys(timeSeries)[0];
                    const latestClosePrice = parseFloat(timeSeries[latestDate]["4. close"]).toFixed(2);
                    const secondLatestDate = Object.keys(timeSeries)[1];
                    const secondLatestClosePrice = parseFloat(timeSeries[secondLatestDate]["4. close"]).toFixed(2);
                    const priceChange = (Number(latestClosePrice) - Number(secondLatestClosePrice)).toFixed(2);
                    const percentChange = ((Number(priceChange) / Number(secondLatestClosePrice)) * 100).toFixed(2);
                    setPrice(latestClosePrice);
                    setPriceChange(priceChange);
                    setPercentChange(percentChange);
                }
                setData(timeSeries);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        fetchData();
    }, [ticker]);

    return (
        <Fragment>
            <h1 className="ticker-header">{ticker}</h1>
            <div className="trading-interface-container">
                <div className="left-column">
                    {error ? (
                        <p className="text-danger">Couldn&apos;t load {ticker}: {error}</p>
                    ) : price === null ? (
                        <p>Loading...</p>
                    ) : (
                        <Fragment>
                            <Price price={price} priceChange={priceChange ?? 0} percentChange={percentChange ?? 0} />
                            <BuySellFunctionality ticker={ticker} price={price} />
                            <div className="candlestick-chart-container">
                                <CandlestickChart data={data} />
                            </div>
                        </Fragment>
                    )}
                </div>
                <div className="right-column">
                    <AIAnalysis ticker={ticker} />
                </div>
            </div>
        </Fragment>
    );
};

export default TradingInterface;
