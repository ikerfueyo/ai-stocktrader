// Earnings figures for the AI analysis: the latest reported quarters against their estimates, the consensus estimates for the
// quarter being reported next and the fiscal years ahead with how they've been revised, and the next report date. Alpha Vantage
// returns decades of each; this picks what matters over the analysis horizon. Pure, so it can be unit tested.

// A reported quarter (Alpha Vantage EARNINGS), dates as "YYYY-MM-DD"
export interface QuarterResult {
    fiscalDateEnding: string;
    reportedDate: string;
    reportedEps: number;
    estimatedEps: number | null;
    // As a fraction of the estimate
    surprise: number | null;
}

// A consensus EPS estimate (Alpha Vantage EARNINGS_ESTIMATES) with the averages it's been revised from
export interface EpsEstimate {
    fiscalDateEnding: string;
    period: "quarter" | "year";
    average: number;
    analysts: number | null;
    average30DaysAgo: number | null;
    average90DaysAgo: number | null;
    revisionsUp30Days: number | null;
    revisionsDown30Days: number | null;
}

// The next scheduled report (Alpha Vantage EARNINGS_CALENDAR)
export interface NextReport {
    reportDate: string;
    fiscalDateEnding: string | null;
    // "pre-market" or "post-market"
    timeOfDay: string | null;
}

export interface EarningsSummary {
    // Newest first
    recent: QuarterResult[];
    // The quarter being reported next, then the fiscal years from the one it ends in
    estimates: (EpsEstimate & { change30Days: number | null; change90Days: number | null })[];
    next: (NextReport & { daysAway: number }) | null;
    // Days since the newest reported quarter's report
    daysSinceReport: number | null;
}

export const RECENT_QUARTERS = 4;
const FISCAL_YEARS = 2;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// The revision as a fraction of the earlier average (of its size, so it reads the same for a loss)
const revision = (average: number, earlier: number | null) => earlier === null || earlier === 0 ? null : (average - earlier) / Math.abs(earlier);

// Any of the three may be missing (null): a company without analysts' estimates, or no report in the calendar's next 3 months.
// Null when there's nothing to show.
export const summarizeEarnings = (quarters: QuarterResult[] | null, estimates: EpsEstimate[] | null, next: NextReport | null, today: string): EarningsSummary | null => {
    const recent = (quarters ?? []).filter(({ reportedDate }) => reportedDate <= today)
        .sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding))
        .slice(0, RECENT_QUARTERS);
    const upcoming = next && next.reportDate >= today ? next : null;
    // The quarter being reported next: the one the calendar names, else the first after the newest reported one (without any
    // results, the first not yet ended). The fiscal years start with the one that quarter ends in.
    const lastReported = recent[0]?.fiscalDateEnding;
    const unreported = (date: string) => lastReported ? date > lastReported : date >= today;
    const byDate = [...(estimates ?? [])].sort((a, b) => a.fiscalDateEnding.localeCompare(b.fiscalDateEnding));
    const quarterEstimates = byDate.filter(({ period }) => period === "quarter");
    const quarter = quarterEstimates.find(({ fiscalDateEnding }) => fiscalDateEnding === upcoming?.fiscalDateEnding)
        ?? quarterEstimates.find(({ fiscalDateEnding }) => unreported(fiscalDateEnding));
    const years = byDate.filter(({ period, fiscalDateEnding }) => period === "year" && (quarter ? fiscalDateEnding >= quarter.fiscalDateEnding : unreported(fiscalDateEnding)))
        .slice(0, FISCAL_YEARS);
    const picked = [...(quarter ? [quarter] : []), ...years].map(estimate => ({
        ...estimate,
        change30Days: revision(estimate.average, estimate.average30DaysAgo),
        change90Days: revision(estimate.average, estimate.average90DaysAgo)
    }));
    if (recent.length === 0 && picked.length === 0 && !upcoming) return null;
    return {
        recent,
        estimates: picked,
        next: upcoming && { ...upcoming, daysAway: daysBetween(today, upcoming.reportDate) },
        daysSinceReport: recent[0] ? daysBetween(recent[0].reportedDate, today) : null
    };
};
