import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchCompanyOverview } from "@/lib/server/marketData";
import type { CompanyOverview } from "@/lib/types";

// Get a company's profile and key figures (Alpha Vantage OVERVIEW, cached 24 hours; 404 for funds and unknown tickers)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    return NextResponse.json<CompanyOverview>(await fetchCompanyOverview(ticker));
});
