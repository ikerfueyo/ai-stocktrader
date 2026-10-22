"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatPrice } from "@/lib/orders";
import type { TickerVerdict, WatchlistItem } from "@/lib/types";

const VERDICT_LABELS: Record<TickerVerdict, string> = { BUY: "Buy", HOLD: "Hold", SELL: "Sell" };

// The user's watchlist on Home: price, today's change, and the AI verdict when one is cached
const Watchlist = () => {
    const [items, setItems] = useState<WatchlistItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getWatchlist = async () => {
            try {
                const response = await axios.get<WatchlistItem[]>("/api/watchlist");
                setItems(response.data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getWatchlist();
    }, []);

    const onRemove = async (ticker: string) => {
        try {
            await axios.delete(`/api/watchlist/${ticker}`);
            setItems(prev => (prev ?? []).filter(item => item.ticker !== ticker));
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        }
    };

    return (
        <section className="watchlist">
            <h2 className="watchlist-title">Watchlist</h2>
            {error ? (
                <p className="text-danger">Couldn&apos;t load your watchlist: {error}</p>
            ) : items === null ? (
                <p>Loading...</p>
            ) : items.length === 0 ? (
                <p className="text-muted">Star a stock on its page (☆) to watch it here.</p>
            ) : (
                <table className="table table-sm text-center">
                    <thead>
                        <tr>
                            <th scope="col">Ticker</th>
                            <th scope="col">Price</th>
                            <th scope="col">Today</th>
                            <th scope="col" title="The latest AI verdict, when one has been made in the last 30 minutes">AI</th>
                            <th scope="col" aria-label="Remove" />
                        </tr>
                    </thead>
                    <tbody>
                        {items.map(({ ticker, price, previousClose, verdict, error: priceError }) => {
                            const change = price !== null && previousClose ? (price - previousClose) / previousClose * 100 : null;
                            return (
                                <tr key={ticker}>
                                    <td><Link href={`/trading/${ticker}`} className="portfolio-ticker">{ticker}</Link></td>
                                    <td title={priceError ?? undefined}>{price !== null ? formatPrice(price) : "—"}</td>
                                    <td className={change === null ? "" : `price-change ${change >= 0 ? "positive" : "negative"}`}>
                                        {change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                                    </td>
                                    <td>{verdict ? <span className={`verdict-tag ${verdict.toLowerCase()}`}>{VERDICT_LABELS[verdict]}</span> : <Link href={`/trading/${ticker}`}>See</Link>}</td>
                                    <td><button type="button" className="btn btn-sm btn-link text-muted" onClick={() => onRemove(ticker)} aria-label={`Remove ${ticker}`}>✕</button></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </section>
    );
};

export default Watchlist;
