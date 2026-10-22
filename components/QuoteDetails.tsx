"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { logError } from "@/lib/apiError";
import { formatPrice } from "@/lib/orders";
import type { CompanyOverview, DailyBar } from "@/lib/types";

// 4954723975000 -> "$4.95T"
const formatLarge = (value: number) => {
    const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    const [size, suffix] = units.find(([unit]) => Math.abs(value) >= unit) ?? [1, ""];
    return `${(value / size).toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
};
const titleCase = (text: string) => text.toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());

// Day range and volume (the newest daily bar), the 52-week range (the last 252 bars), and, from the company overview (funds have
// none), the company's name, listing, sector and key figures
const QuoteDetails = ({ ticker, data }: { ticker: string; data: Record<string, DailyBar> | null }) => {
    const [overview, setOverview] = useState<CompanyOverview | null>(null);

    useEffect(() => {
        const getOverview = async () => {
            setOverview(null);
            try {
                const response = await axios.get<CompanyOverview>(`/api/quote/${ticker}/overview`);
                setOverview(response.data);
            } catch (error) {
                // No overview (a fund, or Alpha Vantage has none): the price figures still show
                if (!axios.isAxiosError(error) || error.response?.status !== 404) logError(error);
            }
        };
        getOverview();
    }, [ticker]);

    const dates = data ? Object.keys(data).sort().reverse() : [];
    const latest = dates.length > 0 ? data![dates[0]] : null;
    const year = dates.slice(0, 252).map(date => data![date]);
    const yearHigh = year.length > 0 ? Math.max(...year.map(bar => parseFloat(bar["2. high"]))) : null;
    const yearLow = year.length > 0 ? Math.min(...year.map(bar => parseFloat(bar["3. low"]))) : null;

    const stats: [string, string | null][] = [
        ["Day range", latest ? `${formatPrice(latest["3. low"])} – ${formatPrice(latest["2. high"])}` : null],
        ["52-week range", yearLow !== null && yearHigh !== null ? `${formatPrice(yearLow)} – ${formatPrice(yearHigh)}` : null],
        ["Volume", latest ? formatLarge(parseFloat(latest["5. volume"])) : null],
        ["Market cap", overview?.marketCap ? `$${formatLarge(overview.marketCap)}` : null],
        ["P/E", overview?.peRatio ? overview.peRatio.toFixed(2) : null],
        ["Forward P/E", overview?.forwardPe ? overview.forwardPe.toFixed(2) : null],
        ["Dividend yield", overview?.dividendYield ? `${(overview.dividendYield * 100).toFixed(2)}%` : null],
        ["Ex-dividend", overview?.exDividendDate ?? null],
        ["Beta", overview?.beta ? overview.beta.toFixed(2) : null]
    ];

    return (
        <section className="quote-details-panel">
            {overview && (
                <p className="company-name">
                    <strong>{overview.name}</strong>
                    {[overview.exchange, overview.sector && titleCase(overview.sector), overview.industry && titleCase(overview.industry)].filter(Boolean).join(" · ")
                        .replace(/^/, " ")}
                </p>
            )}
            <dl className="quote-stats">
                {stats.filter(([, value]) => value !== null).map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
};

export default QuoteDetails;
