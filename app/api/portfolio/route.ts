import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { fetchLatestPrice } from "@/lib/server/alphaVantage";
import { enforceCollateral, getPositions, withAccountLock } from "@/lib/server/portfolio";
import type { PortfolioPosition } from "@/lib/types";

// Get open positions with current prices (Alpha Vantage API, one call per position). Runs the collateral buy-in check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, () => enforceCollateral(userId, "GET /api/portfolio"));
    const positions = (await getPositions(userId)).sort((a, b) => a.ticker.localeCompare(b.ticker));
    // One ticker's price failing (rate limit, outage) shouldn't hide the rest of the portfolio
    const prices = await Promise.allSettled(positions.map(position => fetchLatestPrice(position.ticker)));
    return NextResponse.json<PortfolioPosition[]>(positions.map((position, index) => {
        const result = prices[index];
        if (result.status === "fulfilled") {
            return { ...position, price: result.value, error: null };
        }
        console.error(`GET /api/portfolio: ${position.ticker}: ${result.reason.message}`);
        return { ...position, price: null, error: result.reason.message };
    }));
});
