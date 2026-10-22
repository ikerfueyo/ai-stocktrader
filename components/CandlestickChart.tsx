"use client";

import { Fragment, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { DailyBar, IntradayBar } from "@/lib/types";

// Plotly needs the browser's window, so the chart only renders on the client
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false, loading: () => <p>Loading chart...</p> });

type ChartRange = "1D" | "5D" | "1M" | "6M" | "1Y" | "5Y" | "MAX";
const RANGES: ChartRange[] = ["1D", "5D", "1M", "6M", "1Y", "5Y", "MAX"];
// Daily ranges as calendar days back from the newest bar; 1D and 5D are sessions of 5-minute bars
const DAILY_RANGE_DAYS: Partial<Record<ChartRange, number>> = { "1M": 31, "6M": 183, "1Y": 366, "5Y": 1827 };
const INTRADAY_SESSIONS: Partial<Record<ChartRange, number>> = { "1D": 1, "5D": 5 };

interface Candles {
    x: string[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
}

// Daily bars (data, the full history the page already loaded) filtered to the range, or, for 1D and 5D, 5-minute bars from
// /api/trading/[ticker]/intraday
const CandlestickChart = ({ ticker, data = null }: { ticker: string; data?: Record<string, DailyBar> | null }) => {
    const [range, setRange] = useState<ChartRange>("6M");
    const [intraday, setIntraday] = useState<{ ticker: string; range: ChartRange; bars: IntradayBar[] } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const sessions = INTRADAY_SESSIONS[range];

    useEffect(() => {
        if (!sessions) return;
        const getIntraday = async () => {
            setError(null);
            try {
                const response = await axios.get<IntradayBar[]>(`/api/trading/${ticker}/intraday?days=${sessions}`);
                setIntraday({ ticker, range, bars: response.data });
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getIntraday();
    }, [ticker, range, sessions]);

    if (!data || Object.keys(data).length === 0) {
        return <p>Loading chart data...</p>;
    }

    let candles: Candles | null = null;
    if (sessions) {
        const bars = intraday?.ticker === ticker && intraday.range === range ? intraday.bars : null;
        if (bars) {
            candles = { x: bars.map(({ time }) => time), open: bars.map(bar => bar.open), high: bars.map(bar => bar.high), low: bars.map(bar => bar.low), close: bars.map(bar => bar.close) };
        }
    } else {
        const dates = Object.keys(data).sort();
        const days = DAILY_RANGE_DAYS[range];
        const start = days ? new Date(Date.parse(`${dates.at(-1)}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10) : "";
        const shown = dates.filter(date => date >= start);
        candles = {
            x: shown,
            open: shown.map(date => parseFloat(data[date]["1. open"])),
            high: shown.map(date => parseFloat(data[date]["2. high"])),
            low: shown.map(date => parseFloat(data[date]["3. low"])),
            close: shown.map(date => parseFloat(data[date]["4. close"]))
        };
    }

    return (
        <Fragment>
            <div className="chart-ranges trade-mode-toggle" role="group" aria-label="Chart range">
                {RANGES.map(option => (
                    <button key={option} type="button" className={range === option ? "active" : ""} aria-pressed={range === option} onClick={() => setRange(option)}>
                        {option === "MAX" ? "Max" : option}
                    </button>
                ))}
            </div>
            {error && sessions ? (
                <p className="text-danger">Couldn&apos;t load intraday prices: {error}</p>
            ) : !candles ? (
                <p>Loading chart data...</p>
            ) : (
                <Plot
                    data={[{ ...candles, type: "candlestick", xaxis: "x", yaxis: "y", name: ticker }]}
                    layout={{
                        margin: { t: 10, r: 10, b: 40, l: 50 },
                        xaxis: {
                            rangeslider: { visible: false },
                            // Skip weekends, and nights for 5-minute bars, so the candles don't have gaps
                            rangebreaks: sessions ? [{ bounds: ["sat", "mon"] }, { bounds: [16, 9.5], pattern: "hour" }] : [{ bounds: ["sat", "mon"] }]
                        },
                        yaxis: { title: { text: "Price (USD)" } }
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: "100%", height: "420px" }}
                />
            )}
        </Fragment>
    )
};

export default CandlestickChart;
