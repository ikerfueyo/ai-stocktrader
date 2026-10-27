"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatPrice } from "@/lib/orders";
import type { MarketMovers as Movers, Mover } from "@/lib/types";

const formatVolume = (volume: number) => volume >= 1e6 ? `${(volume / 1e6).toFixed(1)}M` : volume >= 1e3 ? `${(volume / 1e3).toFixed(0)}K` : String(volume);

const MoverTable = ({ title, movers }: { title: string; movers: Mover[] }) => (
    <div>
        <h3 className="movers-title">{title}</h3>
        {movers.length === 0 ? (
            <p className="text-muted">None among tradable stocks.</p>
        ) : (
            <table className="table table-sm text-center">
                <tbody>
                    {movers.map(({ ticker, price, changePercent, volume }) => (
                        <tr key={ticker}>
                            <td><Link href={`/trading/${ticker}`} className="portfolio-ticker">{ticker}</Link></td>
                            <td>{formatPrice(price)}</td>
                            <td className={`price-change ${changePercent >= 0 ? "positive" : "negative"}`}>
                                {changePercent >= 0 ? "+" : ""}{(changePercent * 100).toFixed(2)}%
                            </td>
                            <td className="text-muted" title="Volume">{formatVolume(volume)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )}
    </div>
);

// Today's biggest gainers and losers and the most traded stocks on Home (/api/market/movers)
const MarketMovers = () => {
    const [movers, setMovers] = useState<Movers | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getMovers = async () => {
            try {
                setMovers((await axios.get<Movers>("/api/market/movers")).data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getMovers();
    }, []);

    return (
        <section className="market-movers">
            <h2 className="watchlist-title">Market movers</h2>
            {error ? (
                <p className="text-danger">Couldn&apos;t load the market movers: {error}</p>
            ) : movers === null ? (
                <p>Loading...</p>
            ) : (
                <div className="movers-grid">
                    <MoverTable title="Top gainers" movers={movers.gainers} />
                    <MoverTable title="Top losers" movers={movers.losers} />
                    <MoverTable title="Most active" movers={movers.mostActive} />
                </div>
            )}
        </section>
    );
};

export default MarketMovers;
