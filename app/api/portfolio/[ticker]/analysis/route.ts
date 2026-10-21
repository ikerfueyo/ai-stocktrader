import { NextResponse } from "next/server";
import { UpstreamError, withUser, type TickerContext } from "@/lib/server/errors";
import { analyzePosition } from "@/lib/server/analysis";
import { getPositions } from "@/lib/server/portfolio";
import type { PositionAnalysis } from "@/lib/types";

// Get the hold/sell (or hold/cover for shorts) verdict and analysis of an open position, derived from the ticker's own analysis
// (Alpha Vantage + OpenAI APIs)
export const GET = withUser(async (request, { params }: TickerContext, userId) => {
    const ticker = (await params).ticker.toUpperCase();
    const [position] = await getPositions(userId, ticker);
    if (!position) {
        throw new UpstreamError(`No open position in ${ticker}`, 404);
    }
    return NextResponse.json<PositionAnalysis>(await analyzePosition(ticker, position.quantity > 0 ? "long" : "short"));
});
