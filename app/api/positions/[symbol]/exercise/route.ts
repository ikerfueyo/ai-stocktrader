import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { requireAccount } from "@/lib/server/brokerAccounts";
import { getBroker } from "@/lib/server/broker";
import { enforceMargin, withAccountLock } from "@/lib/server/portfolio";
import { isOptionSymbol } from "@/lib/options";

interface PositionContext {
    params: Promise<{ symbol: string }>;
}

// Exercises a long option position now (body { qty }, else every contract), as Alpaca's POST .../positions/{symbol}/exercise: a call
// buys its shares at the strike, a put sells them. Not between the close and midnight. Returns { qty_exercised, qty_remaining }.
export const POST = withUser(async (request, { params }: PositionContext, userId) => {
    const symbol = (await params).symbol.toUpperCase();
    if (!isOptionSymbol(symbol)) throw new HttpError("Only option contracts can be exercised", 404);
    const body = await request.json().catch(() => ({})) as { qty?: unknown };
    const { accountId } = await requireAccount(request, userId, "trade");
    const result = await withAccountLock(userId, async db => {
        const exercised = await getBroker().exerciseOption(accountId, symbol, body.qty === undefined ? {} : { qty: String(body.qty) });
        await enforceMargin(userId, `POST /api/positions/${symbol}/exercise`, db).catch(error => console.error(`Exercise ${symbol}: margin check: ${error.message}`));
        return exercised;
    });
    return NextResponse.json(result);
});
