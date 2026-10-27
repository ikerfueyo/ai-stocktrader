"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatEastern } from "@/lib/marketHours";
import type { TickerNewsItem } from "@/lib/types";

// Alpha Vantage's sentiment labels: at or beyond ±0.15 an article leans bullish or bearish
const sentimentLabel = (sentiment: number) => sentiment >= 0.15 ? "Bullish" : sentiment <= -0.15 ? "Bearish" : "Neutral";

// The latest articles mainly about a ticker (/api/news/[ticker]), with each one's sentiment for it
const TickerNews = ({ ticker }: { ticker: string }) => {
    const [news, setNews] = useState<TickerNewsItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getNews = async () => {
            setNews(null);
            setError(null);
            try {
                setNews((await axios.get<TickerNewsItem[]>(`/api/news/${ticker}`)).data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getNews();
    }, [ticker]);

    return (
        <section className="ticker-news">
            <h2 className="panel-title">News</h2>
            {error ? (
                <p className="text-danger">Couldn&apos;t load the news: {error}</p>
            ) : news === null ? (
                <p>Loading...</p>
            ) : news.length === 0 ? (
                <p className="text-muted">No recent news mainly about {ticker}.</p>
            ) : (
                <ul>
                    {news.map(({ title, url, published, sentiment }) => (
                        <li key={`${published}-${title}`}>
                            {url ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : title}
                            <span className="ticker-news-meta">
                                {" "}{formatEastern(published, { withDay: true })} ·{" "}
                                <span className={`sentiment ${sentimentLabel(sentiment).toLowerCase()}`}>{sentimentLabel(sentiment)}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default TickerNews;
