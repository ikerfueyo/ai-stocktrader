"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { logError } from "@/lib/apiError";
import { formatPrice } from "@/lib/orders";
import type { CompanyOverview, DailyBars, Quote } from "@/lib/types";

// 4954723975000 -> "$4.95T"
const formatLarge = (value: number) => {
    const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    const [size, suffix] = units.find(([unit]) => Math.abs(value) >= unit) ?? [1, ""];
    return `${(value / size).toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
};
const titleCase = (text: string) => text.toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());

// Day range and volume (the live quote's, else the newest daily bar's), the 52-week range (the last 252 bars), and, from the company
// overview, the company's name, listing, sector, key figures and analysts' consensus
const QuoteDetails = ({ ticker, data, quote = null }: { ticker: string; data: DailyBars | null; quote?: Quote | null }) => {
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

    // The newest bar, and the last 252 sessions' range
    const last = data && data.dates.length > 0 ? data.dates.length - 1 : null;
    const yearHighs = data?.high.slice(-252) ?? [];
    const yearLows = data?.low.slice(-252) ?? [];
    const yearHigh = yearHighs.length > 0 ? Math.max(...yearHighs) : null;
    const yearLow = yearLows.length > 0 ? Math.min(...yearLows) : null;

    const ratings = overview?.analystRatings;
    const ratingCount = ratings ? ratings.strongBuy + ratings.buy + ratings.hold + ratings.sell + ratings.strongSell : 0;
    const dayLow = quote?.low ?? (last !== null ? data!.low[last] : null);
    const dayHigh = quote?.high ?? (last !== null ? data!.high[last] : null);
    const volume = quote?.volume ?? (last !== null ? data!.volume[last] : null);
    const stats: [string, string | null][] = [
        ["Open", quote?.open ? formatPrice(quote.open) : null],
        ["Day range", dayLow !== null && dayHigh !== null ? `${formatPrice(dayLow)} – ${formatPrice(dayHigh)}` : null],
        ["52-week range", yearLow !== null && yearHigh !== null ? `${formatPrice(yearLow)} – ${formatPrice(yearHigh)}` : null],
        ["Volume", volume !== null ? formatLarge(volume) : null],
        ["Market cap", overview?.marketCap ? `$${formatLarge(overview.marketCap)}` : null],
        ["P/E", overview?.peRatio ? overview.peRatio.toFixed(2) : null],
        ["Forward P/E", overview?.forwardPe ? overview.forwardPe.toFixed(2) : null],
        ["Dividend yield", overview?.dividendYield ? `${(overview.dividendYield * 100).toFixed(2)}%` : null],
        ["Ex-dividend", overview?.exDividendDate ?? null],
        ["Beta", overview?.beta ? overview.beta.toFixed(2) : null],
        ["Analyst target", overview?.analystTargetPrice ? formatPrice(overview.analystTargetPrice) : null],
        ["Analyst ratings", ratings && ratingCount > 0
            ? `${ratings.strongBuy + ratings.buy} buy · ${ratings.hold} hold · ${ratings.sell + ratings.strongSell} sell`
            : null]
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
