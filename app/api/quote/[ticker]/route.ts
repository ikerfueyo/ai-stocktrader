import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchQuoteWithBook } from "@/lib/server/marketData";
import type { Quote } from "@/lib/types";

// Get a ticker's latest quote: price, previous close, bid/ask (quoted or simulated), its time and delay, the session's open, high,
// low and volume and any extended-hours price (Alpha Vantage, cached 15s), with Alpaca's top of book and sizes when configured
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    return NextResponse.json<Quote>(await fetchQuoteWithBook(ticker));
});
