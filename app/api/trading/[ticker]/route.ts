import { NextResponse } from "next/server";
import { requireTradableStock } from "@/lib/server/assets";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchRecentDailySeries, toDailyBars } from "@/lib/server/marketData";
import type { DailyBars } from "@/lib/types";

// Get a tradable stock's full daily history as compact bars (Alpha Vantage API, shared for a minute with its analysis); 404 for a ticker outside the universe, such as an ETF. Orders, market ones
// included, go to POST /api/orders.
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    await requireTradableStock(ticker);
    return NextResponse.json<DailyBars>(toDailyBars(await fetchRecentDailySeries(ticker, "full")));
});
