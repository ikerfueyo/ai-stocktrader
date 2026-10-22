import { NextResponse } from "next/server";
import { UpstreamError, withUser, type TickerContext } from "@/lib/server/errors";
import { analyzePosition } from "@/lib/server/analysis";
import { fetchPrices } from "@/lib/server/alphaVantage";
import { valueAccount } from "@/lib/server/account";
import { getAccount } from "@/lib/server/portfolio";
import type { PositionAnalysis } from "@/lib/types";

// Get the hold/sell (or hold/cover for shorts) verdict and structured analysis of an open position, derived from the ticker's own
// analysis and written with the position's size, P&L and weight in the account (Alpha Vantage + OpenAI APIs; the prices are
// shared with the Portfolio page by the quote cache)
export const GET = withUser(async (request, { params }: TickerContext, userId) => {
    const ticker = (await params).ticker.toUpperCase();
    const { positions, totalCash } = await getAccount(userId);
    const position = positions.find(({ ticker: symbol }) => symbol === ticker);
    if (!position) {
        throw new UpstreamError(`No open position in ${ticker}`, 404);
    }
    const { prices, staleTickers } = await fetchPrices(positions.map(({ ticker: symbol }) => symbol), `GET /api/portfolio/${ticker}/analysis`);
    const { equity } = valueAccount({ positions, totalCash, prices, staleTickers });
    const price = prices[ticker] ?? null;
    const side = position.quantity > 0 ? "long" : "short";
    const shares = Math.abs(position.quantity);
    return NextResponse.json<PositionAnalysis>(await analyzePosition(userId, ticker, side, {
        shares, avgCost: position.avgCost, price,
        unrealizedPnlPercent: price === null ? null : (side === "long" ? price / position.avgCost - 1 : 1 - price / position.avgCost),
        weight: price !== null && equity > 0 ? shares * price / equity : null
    }));
});
