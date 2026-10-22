import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { analyzeTicker, publicAnalysis } from "@/lib/server/analysis";
import type { TickerAnalysis } from "@/lib/types";

// Get the buy/hold/sell verdict and structured analysis of a stock from its news, price and technicals, and valuation (Alpha
// Vantage + OpenAI APIs)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const analysis = await analyzeTicker((await params).ticker.toUpperCase());
    return NextResponse.json<TickerAnalysis>(publicAnalysis(analysis));
});
