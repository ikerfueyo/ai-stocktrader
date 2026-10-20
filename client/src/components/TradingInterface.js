import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import Price from "./Price";
import BuySellFunctionality from "./BuySellFunctionality";
import CandlestickChart from "./CandlestickChart";
import AIAnalysis from "./AIAnalysis";

const TradingInterface = ({ ticker }) => {

    const [data, setData] = useState(null);
    const [price, setPrice] = useState(null);
    const [priceChange, setPriceChange] = useState(null);
    const [percentChange, setPercentChange] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchData = async () => {
            // Clear the previous ticker's price so it can't be traded while the new one loads
            setPrice(null);
            setData(null);
            setError(null);
            try {
                const response = await axios.get(`/trading/${ticker}`);
                const timeSeries = response.data["Time Series (Daily)"];
                // const response = timeseries;
                // const timeSeries = response["Time Series (Daily)"];
                if (timeSeries) {
                    // Close price, price change, and percent change
                    const latestDate = Object.keys(timeSeries)[0];
                    const latestClosePrice = parseFloat(timeSeries[latestDate]["4. close"]).toFixed(2);
                    const secondLatestDate = Object.keys(timeSeries)[1];
                    const secondLatestClosePrice = parseFloat(timeSeries[secondLatestDate]["4. close"]).toFixed(2);
                    const priceChange = (latestClosePrice - secondLatestClosePrice).toFixed(2);
                    const percentChange = ((priceChange / secondLatestClosePrice) * 100).toFixed(2);
                    setPrice(latestClosePrice);
                    setPriceChange(priceChange);
                    setPercentChange(percentChange);
                }
                setData(timeSeries);
            } catch (error) {
                console.error(error.message);
                setError(error.response?.data?.error ?? error.message);
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
                        <p className="text-danger">Couldn't load {ticker}: {error}</p>
                    ) : price === null ? (
                        <p>Loading...</p>
                    ) : (
                        <Fragment>
                            <Price price={price} priceChange={priceChange} percentChange={percentChange} />
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
