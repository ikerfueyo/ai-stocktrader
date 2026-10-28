"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import Price from "./Price";
import BuySellFunctionality from "./BuySellFunctionality";
import CandlestickChart from "./CandlestickChart";
import AIAnalysis from "./AIAnalysis";
import MarketStatusBadge from "./MarketStatusBadge";
import OpenOrders from "./OpenOrders";
import QuoteDetails from "./QuoteDetails";
import EarningsDetails from "./EarningsDetails";
import CorporateActions from "./CorporateActions";
import TickerNews from "./TickerNews";
import WatchlistStar from "./WatchlistStar";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { MarketStatus } from "@/lib/marketHours";
import type { DailyBar, DailySeries, Quote } from "@/lib/types";

const TradingInterface = ({ ticker }: { ticker: string }) => {

    const [data, setData] = useState<Record<string, DailyBar> | null>(null);
    // The latest close and the one before it, from the daily series, shown when the quote can't be loaded
    const [seriesPrice, setSeriesPrice] = useState<{ price: number; previousClose: number | null } | null>(null);
    // The quote trades fill against (bid/ask, time and delay); orders need it
    const [quote, setQuote] = useState<Quote | null>(null);
    const [quoteError, setQuoteError] = useState<string | null>(null);
    const [market, setMarket] = useState<MarketStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Bumped after an order to reload the quote, the market status and the open orders
    const [quoteVersion, setQuoteVersion] = useState(0);

    useEffect(() => {
        const loadQuote = async () => {
            try {
                const [quoteResponse, marketResponse] = await Promise.all([axios.get<Quote>(`/api/quote/${ticker}`), axios.get<MarketStatus>("/api/market")]);
                setQuote(quoteResponse.data);
                setMarket(marketResponse.data);
                setQuoteError(null);
            } catch (error) {
                logError(error);
                setQuoteError(apiErrorMessage(error));
            }
        };
        loadQuote();
    }, [ticker, quoteVersion]);

    useEffect(() => {
        const fetchData = async () => {
            // Clear the previous ticker's price so it can't be traded while the new one loads
            setQuote(null);
            setSeriesPrice(null);
            setData(null);
            setError(null);
            try {
                const response = await axios.get<DailySeries>(`/api/trading/${ticker}`);
                const timeSeries = response.data["Time Series (Daily)"];
                if (timeSeries) {
                    const [latestDate, previousDate] = Object.keys(timeSeries);
                    setSeriesPrice({
                        price: parseFloat(timeSeries[latestDate]["4. close"]),
                        previousClose: previousDate ? parseFloat(timeSeries[previousDate]["4. close"]) : null
                    });
                }
                setData(timeSeries);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        fetchData();
    }, [ticker]);

    const shown = quote ? { price: quote.price, previousClose: quote.previousClose ?? seriesPrice?.previousClose ?? null } : seriesPrice;

    return (
        <Fragment>
            <div className="ticker-title">
                <h1 className="ticker-header">{ticker}</h1>
                <WatchlistStar ticker={ticker.toUpperCase()} />
            </div>
            <MarketStatusBadge status={market} />
            <div className="trading-interface-container">
                <div className="left-column">
                    {error ? (
                        <p className="text-danger">Couldn&apos;t load {ticker}: {error}</p>
                    ) : shown === null ? (
                        <p>Loading...</p>
                    ) : (
                        <Fragment>
                            <Price price={shown.price} previousClose={shown.previousClose} quote={quote} />
                            {quote ? (
                                <BuySellFunctionality ticker={ticker} quote={quote} market={market} onTraded={() => setQuoteVersion(version => version + 1)} />
                            ) : quoteError ? (
                                <p className="text-danger">Couldn&apos;t get a quote for {ticker}, so it can&apos;t be traded right now: {quoteError}</p>
                            ) : null}
                            <OpenOrders ticker={ticker} refreshKey={quoteVersion} />
                            <QuoteDetails ticker={ticker.toUpperCase()} data={data} quote={quote} />
                            <EarningsDetails ticker={ticker.toUpperCase()} />
                            <CorporateActions ticker={ticker.toUpperCase()} />
                            <CandlestickChart ticker={ticker.toUpperCase()} data={data} />
                        </Fragment>
                    )}
                </div>
                <div className="right-column">
                    <AIAnalysis ticker={ticker} />
                    <TickerNews ticker={ticker.toUpperCase()} />
                </div>
            </div>
        </Fragment>
    );
};

export default TradingInterface;
