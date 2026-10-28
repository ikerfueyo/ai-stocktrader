import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { requireTradableStock } from "@/lib/server/assets";
import { fetchOptionChain } from "@/lib/server/marketData";
import { easternParts } from "@/lib/marketHours";
import type { OptionChainResponse } from "@/lib/types";

// A stock's option chain for one expiration (?expiration=, else the nearest): every listed expiration, and each contract's bid, ask
// and mark now (Alpha Vantage's realtime options when the plan has them, else modeled from the last close), implied volatility,
// Greeks, open interest and the last session's volume and closing mark
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    await requireTradableStock(ticker);
    const chain = await fetchOptionChain(ticker);
    const expirations = [...new Set(chain.contracts.map(({ expiration }) => expiration))];
    const asked = request.nextUrl.searchParams.get("expiration");
    const expiration = asked && expirations.includes(asked) ? asked : expirations[0];
    const today = easternParts(new Date()).dateKey;
    return NextResponse.json<OptionChainResponse>({
        underlying: { symbol: ticker, price: chain.underlying.price, previousClose: chain.underlying.previousClose, quoteTime: chain.underlying.quoteTime, delay: chain.underlying.delay },
        source: chain.source, asOf: chain.asOf, today, expirations, expiration,
        contracts: chain.contracts.filter(contract => contract.expiration === expiration).map(contract => ({
            symbol: contract.symbol, type: contract.type, strike: contract.strike, expiration: contract.expiration,
            bid: contract.quote.bid, ask: contract.quote.ask, mark: contract.quote.price, closeMark: contract.mark, volume: contract.volume, openInterest: contract.openInterest,
            impliedVolatility: contract.quote.impliedVolatility, delta: contract.quote.delta, gamma: contract.quote.gamma, theta: contract.quote.theta, vega: contract.quote.vega
        }))
    });
});
