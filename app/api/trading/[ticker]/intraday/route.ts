import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchIntraday } from "@/lib/server/alphaVantage";
import type { IntradayBar } from "@/lib/types";

// Get the last ?days= sessions (1 to 20, default 1) of 5-minute bars in the regular session, oldest first (Alpha Vantage
// TIME_SERIES_INTRADAY, cached 60s)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    const days = Math.min(20, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 1));
    const bars = await fetchIntraday(ticker);
    const sessions = [...new Set(bars.map(({ time }) => time.slice(0, 10)))].slice(-days);
    return NextResponse.json<IntradayBar[]>(bars.filter(({ time }) => sessions.includes(time.slice(0, 10))));
});
