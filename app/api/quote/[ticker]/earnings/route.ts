import { NextResponse } from "next/server";
import { HttpError, withUser, type TickerContext } from "@/lib/server/errors";
import { fetchEarnings, fetchEarningsEstimates, fetchNextReport } from "@/lib/server/marketData";
import { summarizeEarnings } from "@/lib/server/earnings";
import { easternParts } from "@/lib/marketHours";
import type { EarningsResponse } from "@/lib/types";

// Get a stock's latest reported quarters against their estimates, the consensus estimates ahead with their revisions, and the next
// report date (Alpha Vantage EARNINGS, EARNINGS_ESTIMATES and EARNINGS_CALENDAR, each cached 12 hours, shared with the AI analysis).
// Any of the three may be missing; 404 when all are.
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    const [quarters, estimates, next] = await Promise.all([
        fetchEarnings(ticker).catch(() => null),
        fetchEarningsEstimates(ticker).catch(() => null),
        fetchNextReport(ticker).catch(() => null)
    ]);
    const summary = summarizeEarnings(quarters, estimates, next, easternParts(new Date()).dateKey);
    if (!summary) throw new HttpError(`No earnings data for ${ticker}`, 404);
    return NextResponse.json<EarningsResponse>(summary);
});
