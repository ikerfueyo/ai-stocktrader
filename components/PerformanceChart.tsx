"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, formatSigned } from "@/lib/orders";
import type { HistoryRange, PortfolioHistory } from "@/lib/types";

// Plotly needs the browser's window, so the chart only renders on the client
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false, loading: () => <p>Loading chart...</p> });

const RANGES: HistoryRange[] = ["1W", "1M", "3M", "YTD", "1Y", "ALL"];

const formatPercent = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(2)}%`;

// The account's performance over a range: equity, the gain excluding deposits and withdrawals, and the time-weighted return
// against SPY, from /api/portfolio/history
const PerformanceChart = () => {
    const [range, setRange] = useState<HistoryRange>("1M");
    const [history, setHistory] = useState<PortfolioHistory | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Switching ranges cancels the previous request, so a slower earlier response can't replace the newer range's figures
        const controller = new AbortController();
        const getHistory = async () => {
            setError(null);
            try {
                const response = await axios.get<PortfolioHistory>(`/api/portfolio/history?range=${range}`, { signal: controller.signal });
                setHistory(response.data);
            } catch (error) {
                if (axios.isCancel(error)) return;
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getHistory();
        return () => controller.abort();
    }, [range]);

    const points = history?.points ?? [];
    const first = points[0];
    const last = points.at(-1);
    // The gain over the range, with money moved in or out taken out
    const gain = first && last ? last.equity - first.equity - (last.netDeposits - first.netDeposits) : 0;
    const benchmarkReturn = history?.benchmarkReturn ?? null;
    const twr = history?.twr ?? null;
    // Days that started with zero or negative equity have no return
    const partialReturn = points.some(({ twr }) => twr === null);

    return (
        <section className="performance">
            <div className="performance-header">
                <div className="performance-stats">
                    <div className="account-stat">
                        <span className="account-label">Equity</span>
                        <span className="account-value">{last ? formatCurrency(last.equity) : "…"}</span>
                    </div>
                    <div className="account-stat">
                        <span className="account-label">Gain ({range})</span>
                        <span className={`account-value price-change ${gain >= 0 ? "positive" : "negative"}`}>{last ? formatSigned(gain) : "…"}</span>
                    </div>
                    <div className="account-stat" title="Time-weighted return: each day's return with deposits and withdrawals taken out, chained">
                        <span className="account-label">Return</span>
                        <span className={`account-value price-change ${(twr ?? 0) >= 0 ? "positive" : "negative"}`}>{history ? (twr === null ? "—" : formatPercent(twr)) : "…"}</span>
                    </div>
                    <div className="account-stat" title={`${history?.benchmark ?? "SPY"}'s price change over the same days (dividends not included)`}>
                        <span className="account-label">{history?.benchmark ?? "SPY"}</span>
                        <span className={`account-value price-change ${(benchmarkReturn ?? 0) >= 0 ? "positive" : "negative"}`}>{benchmarkReturn !== null ? formatPercent(benchmarkReturn) : "—"}</span>
                    </div>
                </div>
                <div className="trade-mode-toggle" role="group" aria-label="Range">
                    {RANGES.map(option => (
                        <button key={option} type="button" className={range === option ? "active" : ""} aria-pressed={range === option} onClick={() => setRange(option)}>{option}</button>
                    ))}
                </div>
            </div>
            {error ? (
                <p className="text-danger">Couldn&apos;t load performance: {error}</p>
            ) : history === null ? (
                <p>Loading performance...</p>
            ) : points.length < 2 ? (
                <p className="text-muted">Not enough history for this range yet.</p>
            ) : (
                <Plot
                    data={[
                        {
                            x: points.map(({ date }) => date), y: points.map(({ twr }) => twr === null ? null : twr * 100),
                            type: "scatter", mode: "lines", name: "Your return", line: { color: "#00a5a8", width: 3 },
                            customdata: points.map(({ equity }) => formatCurrency(equity)),
                            hovertemplate: "%{x}<br>Return %{y:.2f}%<br>Equity %{customdata}<extra></extra>"
                        },
                        {
                            x: points.map(({ date }) => date), y: points.map(({ benchmark }) => benchmark === null ? null : benchmark * 100),
                            type: "scatter", mode: "lines", name: history.benchmark, line: { color: "#868e96", width: 2, dash: "dot" },
                            hovertemplate: "%{x}<br>" + history.benchmark + " %{y:.2f}%<extra></extra>"
                        }
                    ]}
                    layout={{
                        margin: { t: 10, r: 10, b: 40, l: 50 },
                        yaxis: { ticksuffix: "%", zeroline: true },
                        legend: { orientation: "h", y: -0.15 },
                        hovermode: "x unified"
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: "100%", height: "320px" }}
                />
            )}
            {partialReturn && (
                <p className="text-muted">Gaps in your return are days that began with zero or negative equity, when a return isn&apos;t defined.</p>
            )}
            {history && history.missing.length > 0 && (
                <p className="text-muted">No price history for {history.missing.join(", ")}; valued at cost.</p>
            )}
        </section>
    );
};

export default PerformanceChart;
