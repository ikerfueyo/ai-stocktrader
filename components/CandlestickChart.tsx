"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { Shape } from "plotly.js";
import type { DailyBars, IntradayBar } from "@/lib/types";
import { CHART_COLORS, CHART_LAYOUT } from "@/lib/chartTheme";
import Plot from "./Plot";


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
const CandlestickChart = ({ ticker, data = null }: { ticker: string; data?: DailyBars | null }) => {
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

    // The daily candles in the range, worked out again only when the range or the data changes
    const dailyCandles = useMemo((): Candles | null => {
        if (!data || data.dates.length === 0 || sessions) return null;
        const days = DAILY_RANGE_DAYS[range];
        const start = days ? new Date(Date.parse(`${data.dates.at(-1)}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10) : "";
        // Dates are oldest first, so the range is the tail from the first date on or after start
        const from = Math.max(0, data.dates.findIndex(date => date >= start));
        return { x: data.dates.slice(from), open: data.open.slice(from), high: data.high.slice(from), low: data.low.slice(from), close: data.close.slice(from) };
    }, [data, range, sessions]);

    if (!data || data.dates.length === 0) {
        return <p>Loading chart data...</p>;
    }

    let candles: Candles | null = null;
    // Each day's pre-market and after-hours stretches, shaded behind the 5-minute candles
    let extendedShading: Partial<Shape>[] = [];
    if (sessions) {
        const bars = intraday?.ticker === ticker && intraday.range === range ? intraday.bars : null;
        if (bars) {
            candles = { x: bars.map(({ time }) => time), open: bars.map(bar => bar.open), high: bars.map(bar => bar.high), low: bars.map(bar => bar.low), close: bars.map(bar => bar.close) };
            const days = [...new Set(bars.map(({ time }) => time.slice(0, 10)))];
            const shade = (x0: string, x1: string): Partial<Shape> => ({
                type: "rect", xref: "x", yref: "paper", x0, x1, y0: 0, y1: 1, fillcolor: "#6c757d", opacity: 0.08, line: { width: 0 }, layer: "below"
            });
            extendedShading = days.flatMap(day => [shade(`${day} 04:00:00`, `${day} 09:30:00`), shade(`${day} 16:00:00`, `${day} 20:00:00`)]);
        }
    } else {
        candles = dailyCandles;
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
                    data={[{
                        ...candles, type: "candlestick", xaxis: "x", yaxis: "y", name: ticker,
                        increasing: { line: { color: CHART_COLORS.gain } },
                        decreasing: { line: { color: CHART_COLORS.loss } }
                    }]}
                    layout={{
                        ...CHART_LAYOUT,
                        margin: { t: 10, r: 10, b: 40, l: 56 },
                        xaxis: {
                            ...CHART_LAYOUT.xaxis,
                            // Set rather than guessed: Plotly's finance bundle guesses a candlestick's price axis is dates
                            type: "date",
                            rangeslider: { visible: false },
                            // Skip weekends, and nights (8:00 p.m. to 4:00 a.m.) for 5-minute bars, so the candles don't have gaps
                            rangebreaks: sessions ? [{ bounds: ["sat", "mon"] }, { bounds: [20, 4], pattern: "hour" }] : [{ bounds: ["sat", "mon"] }]
                        },
                        shapes: extendedShading,
                        yaxis: { ...CHART_LAYOUT.yaxis, type: "linear", title: { text: "Price (USD)", font: { size: 12, color: CHART_COLORS.text } } }
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: "100%", height: "420px" }}
                />
            )}
        </Fragment>
    )
};

export default CandlestickChart;
