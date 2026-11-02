import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { filterTradable } from "@/lib/server/assets";
import { fetchTopMovers } from "@/lib/server/marketData";
import type { MarketMovers } from "@/lib/types";

// Up to this many of each list are returned
const PER_LIST = 5;

// Get today's biggest gainers and losers and the most traded stocks (Alpha Vantage TOP_GAINERS_LOSERS, realtime, cached a minute),
// keeping only tradable stocks, since the lists are mostly warrants, units and ETFs
export const GET = withUser(async () => {
    const { gainers, losers, mostActive, updatedAt } = await fetchTopMovers();
    const tradable = new Set(await filterTradable([...gainers, ...losers, ...mostActive].map(({ ticker }) => ticker)));
    const keep = (movers: MarketMovers["gainers"]) => movers.filter(({ ticker }) => tradable.has(ticker)).slice(0, PER_LIST);
    return NextResponse.json<MarketMovers>({ gainers: keep(gainers), losers: keep(losers), mostActive: keep(mostActive), updatedAt });
});
