import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getMarketStatus } from "@/lib/server/market";
import type { MarketStatus } from "@/lib/marketHours";

// Get whether the U.S. market is open, and its next open and close (NYSE calendar plus Alpha Vantage's market status)
export const GET = withUser(async () => NextResponse.json<MarketStatus>(await getMarketStatus()));
