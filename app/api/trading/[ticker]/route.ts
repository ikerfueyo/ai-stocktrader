import { NextResponse } from "next/server";
import { requireTradableStock } from "@/lib/server/assets";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchDailySeries } from "@/lib/server/marketData";

// Get a tradable stock's daily series (Alpha Vantage API); 404 for a ticker outside the universe, such as an ETF. Orders, market ones
// included, go to POST /api/orders.
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    await requireTradableStock(ticker);
    return NextResponse.json(await fetchDailySeries(ticker, "full"));
});
