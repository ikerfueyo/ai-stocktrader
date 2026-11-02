"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { logError } from "@/lib/apiError";
import type { EarningsResponse } from "@/lib/types";

const formatEps = (eps: number) => `${eps < 0 ? "-" : ""}$${Math.abs(eps).toFixed(2)}`;
const formatPercent = (fraction: number | null) => fraction === null ? "—" : `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;
const changeClass = (fraction: number | null) => fraction === null ? "" : `price-change ${fraction >= 0 ? "positive" : "negative"}`;
const TIME_OF_DAY: Record<string, string> = { "pre-market": "before the open", "post-market": "after the close" };

// A stock's next earnings report, its latest reported quarters against their estimates, and the consensus EPS estimates ahead with
// how they've been revised (/api/quote/[ticker]/earnings). Hidden when there's none, such as for a company without coverage.
const EarningsDetails = ({ ticker }: { ticker: string }) => {
    const [earnings, setEarnings] = useState<EarningsResponse | null>(null);

    useEffect(() => {
        const getEarnings = async () => {
            setEarnings(null);
            try {
                setEarnings((await axios.get<EarningsResponse>(`/api/quote/${ticker}/earnings`)).data);
            } catch (error) {
                if (!axios.isAxiosError(error) || error.response?.status !== 404) logError(error);
            }
        };
        getEarnings();
    }, [ticker]);

    if (!earnings) return null;
    const { next, recent, estimates } = earnings;

    return (
        <section className="earnings-details">
            <h2 className="panel-title">Earnings</h2>
            {next && (
                <p className="earnings-next">
                    Next report <strong>{next.reportDate}</strong>
                    {next.timeOfDay && TIME_OF_DAY[next.timeOfDay] ? `, ${TIME_OF_DAY[next.timeOfDay]}` : ""}
                    {` (${next.daysAway === 0 ? "today" : `in ${next.daysAway} day${next.daysAway === 1 ? "" : "s"}`})`}
                </p>
            )}
            {recent.length > 0 && (
                <table className="table table-sm text-center">
                    <thead>
                        <tr><th scope="col">Quarter</th><th scope="col">Reported</th><th scope="col">EPS</th><th scope="col">Estimate</th><th scope="col">Surprise</th></tr>
                    </thead>
                    <tbody>
                        {recent.map(({ fiscalDateEnding, reportedDate, reportedEps, estimatedEps, surprise }) => (
                            <tr key={fiscalDateEnding}>
                                <td>{fiscalDateEnding}</td>
                                <td>{reportedDate}</td>
                                <td>{formatEps(reportedEps)}</td>
                                <td>{estimatedEps === null ? "—" : formatEps(estimatedEps)}</td>
                                <td className={changeClass(surprise)}>{formatPercent(surprise)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {estimates.length > 0 && (
                <table className="table table-sm text-center">
                    <thead>
                        <tr>
                            <th scope="col">Estimate for</th><th scope="col">EPS</th><th scope="col">Analysts</th>
                            <th scope="col" title="Change in the consensus over the last 30 days">30 days</th>
                            <th scope="col" title="Change in the consensus over the last 90 days">90 days</th>
                        </tr>
                    </thead>
                    <tbody>
                        {estimates.map(({ fiscalDateEnding, period, average, analysts, change30Days, change90Days }) => (
                            <tr key={`${period}-${fiscalDateEnding}`}>
                                <td>{period === "quarter" ? "Quarter" : "Fiscal year"} ending {fiscalDateEnding}</td>
                                <td>{formatEps(average)}</td>
                                <td>{analysts ?? "—"}</td>
                                <td className={changeClass(change30Days)}>{formatPercent(change30Days)}</td>
                                <td className={changeClass(change90Days)}>{formatPercent(change90Days)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
};

export default EarningsDetails;
