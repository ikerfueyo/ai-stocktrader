import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchQuote } from "@/lib/server/alphaVantage";
import type { Quote } from "@/lib/types";

// Get a ticker's latest quote: price, previous close, bid/ask (quoted or simulated), its time and delay (Alpha Vantage API, cached 60s)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    return NextResponse.json<Quote>(await fetchQuote(ticker));
});
