import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { summarizeEarnings, type EpsEstimate, type QuarterResult } from "./earnings";

const quarter = (fiscalDateEnding: string, reportedDate: string, reportedEps = 2, estimatedEps: number | null = 1.9): QuarterResult =>
    ({ fiscalDateEnding, reportedDate, reportedEps, estimatedEps, surprise: estimatedEps ? (reportedEps - estimatedEps) / estimatedEps : null });
const estimate = (fiscalDateEnding: string, period: "quarter" | "year", average: number, average30DaysAgo: number | null = null, average90DaysAgo: number | null = null): EpsEstimate =>
    ({ fiscalDateEnding, period, average, analysts: 20, average30DaysAgo, average90DaysAgo, revisionsUp30Days: 2, revisionsDown30Days: 1 });

// Shaped like Apple's in October 2026: the September quarter (and fiscal year) ended but not yet reported
const quarters = [
    quarter("2025-09-30", "2025-10-30"), quarter("2025-12-31", "2026-01-29"), quarter("2026-03-31", "2026-04-30"),
    quarter("2026-06-30", "2026-07-30", 2.02, 1.88), quarter("2024-06-30", "2024-08-01")
];
const estimates = [
    estimate("2026-06-30", "quarter", 1.89), estimate("2026-09-30", "quarter", 1.98, 1.96, 2.0), estimate("2026-12-31", "quarter", 2.9),
    estimate("2025-09-30", "year", 7.4), estimate("2026-09-30", "year", 8.82, 8.8), estimate("2027-09-30", "year", 9.57), estimate("2028-09-30", "year", 10.4)
];

describe("Earnings summary", () => {
    test("the latest 4 reported quarters, newest first, and the days since the last report", () => {
        const summary = summarizeEarnings(quarters, null, null, "2026-10-21")!;
        assert.deepEqual(summary.recent.map(({ fiscalDateEnding }) => fiscalDateEnding), ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"]);
        assert.equal(summary.daysSinceReport, 83);
    });

    test("estimates for the quarter reported next and the fiscal years from the one it ends in, with their revisions", () => {
        const summary = summarizeEarnings(quarters, estimates, { reportDate: "2026-11-02", fiscalDateEnding: "2026-09-30", timeOfDay: "post-market" }, "2026-10-21")!;
        assert.deepEqual(summary.estimates.map(({ fiscalDateEnding, period }) => `${period} ${fiscalDateEnding}`), ["quarter 2026-09-30", "year 2026-09-30", "year 2027-09-30"]);
        assert.ok(Math.abs(summary.estimates[0].change30Days! - (1.98 / 1.96 - 1)) < 1e-12);
        assert.ok(Math.abs(summary.estimates[0].change90Days! - (1.98 / 2 - 1)) < 1e-12);
        assert.equal(summary.estimates[2].change30Days, null);
        assert.equal(summary.next!.daysAway, 12);
    });

    test("without the calendar, the quarter after the newest reported one", () => {
        const summary = summarizeEarnings(quarters, estimates, null, "2026-10-21")!;
        assert.equal(summary.estimates[0].fiscalDateEnding, "2026-09-30");
        assert.equal(summary.next, null);
    });

    test("revisions are measured against the size of an earlier loss estimate", () => {
        const summary = summarizeEarnings(null, [estimate("2026-12-31", "quarter", -0.5, -1)], null, "2026-10-21")!;
        assert.equal(summary.estimates[0].change30Days, 0.5);
    });

    test("a past report date isn't upcoming, and nothing at all is null", () => {
        assert.equal(summarizeEarnings(quarters, null, { reportDate: "2026-10-01", fiscalDateEnding: null, timeOfDay: null }, "2026-10-21")!.next, null);
        assert.equal(summarizeEarnings(null, null, null, "2026-10-21"), null);
        assert.equal(summarizeEarnings([quarter("2026-09-30", "2026-10-30")], [], null, "2026-10-21"), null);
    });
});
