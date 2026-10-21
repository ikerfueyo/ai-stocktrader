import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { analyzeTicker } from "@/lib/server/analysis";
import type { TickerAnalysis } from "@/lib/types";

// Get the buy/hold/sell verdict and analysis of a stock from its news sentiment (Alpha Vantage + OpenAI APIs)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const { verdict, analysis } = await analyzeTicker((await params).ticker.toUpperCase());
    return NextResponse.json<TickerAnalysis>({ verdict, analysis });
});
