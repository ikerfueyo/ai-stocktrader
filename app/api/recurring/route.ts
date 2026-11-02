import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { requireAccount } from "@/lib/server/brokerAccounts";
import { createRecurring, listRecurring } from "@/lib/server/automation/recurring";
import type { Frequency } from "@/lib/automation";

// The user's recurring investments (active and paused)
export const GET = withUser(async (request, context, userId) => NextResponse.json({ recurring: await listRecurring(userId) }));

// Body { recurring: { symbol, amount, frequency: daily | weekly | biweekly | monthly, startDate } }, on the active account (which must be
// able to trade); 201
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { recurring?: { symbol?: unknown; amount?: unknown; frequency?: unknown; startDate?: unknown } } | null;
    const input = body?.recurring;
    if (typeof input?.symbol !== "string" || !input.symbol.trim()) throw new HttpError("recurring.symbol is required", 400);
    const { accountId } = await requireAccount(request, userId, "trade");
    return NextResponse.json({
        recurring: await createRecurring(userId, accountId, { symbol: input.symbol.trim(), amount: Number(input.amount), frequency: input.frequency as Frequency, startDate: String(input.startDate ?? "") })
    }, { status: 201 });
});
