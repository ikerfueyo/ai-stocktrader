import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { requireAccount } from "@/lib/server/brokerAccounts";
import { getBroker } from "@/lib/server/broker";
import { isOptionSymbol } from "@/lib/options";

interface PositionContext {
    params: Promise<{ symbol: string }>;
}

// Leaves a long option position unexercised at expiration even if it's in the money (Alpaca's do-not-exercise instruction)
export const POST = withUser(async (request, { params }: PositionContext, userId) => {
    const symbol = (await params).symbol.toUpperCase();
    if (!isOptionSymbol(symbol)) throw new HttpError("Only option contracts can be left unexercised", 404);
    const { accountId } = await requireAccount(request, userId, "trade");
    await getBroker().doNotExercise(accountId, symbol);
    return NextResponse.json({ symbol, instruction: "do_not_exercise" });
});
