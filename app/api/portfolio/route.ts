import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { fetchQuotes } from "@/lib/server/alphaVantage";
import { enforceCollateral, getPositions, withAccountLock } from "@/lib/server/portfolio";
import type { PortfolioPosition } from "@/lib/types";

// Get open positions with current prices (Alpha Vantage API, fetched together, shared with /api/account by the quote cache). Runs the
// collateral buy-in check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, db => enforceCollateral(userId, "GET /api/portfolio", db));
    const positions = (await getPositions(userId)).sort((a, b) => a.ticker.localeCompare(b.ticker));
    // One ticker's price failing (rate limit, outage) shouldn't hide the rest of the portfolio
    const quotes = await Promise.allSettled(fetchQuotes(positions.map(({ ticker }) => ticker)));
    return NextResponse.json<PortfolioPosition[]>(positions.map((position, index) => {
        const result = quotes[index];
        if (result.status === "fulfilled") {
            const { price, bid, ask } = result.value;
            return { ...position, price, bid, ask, error: null };
        }
        console.error(`GET /api/portfolio: ${position.ticker}: ${result.reason.message}`);
        return { ...position, price: null, bid: null, ask: null, error: result.reason.message };
    }));
});
