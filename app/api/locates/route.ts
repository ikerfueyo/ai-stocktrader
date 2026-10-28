import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { requireAccount } from "@/lib/server/brokerAccounts";
import { HttpError, withUser } from "@/lib/server/errors";
import { ledgerAccountId, withAccountLock } from "@/lib/server/portfolio";
import type { BrokerLocateRequest, Locate } from "@/lib/types";

// The account's locates for hard-to-borrow short sales, newest first (?status=active|expired|rejected, ?symbol=)
export const GET = withUser(async (request, context, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) return NextResponse.json({ locates: [], next_page_token: null });
    const params = request.nextUrl.searchParams;
    return NextResponse.json(await getBroker().listLocates(accountId, { status: params.get("status") ?? undefined, symbol: params.get("symbol") ?? undefined }));
});

// Locate shares of a hard-to-borrow stock before shorting it (Alpaca's CreateLocateRequest: symbol, qty in round lots of 100,
// limit_price, all_or_none); the fee is charged at once and isn't refunded
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<BrokerLocateRequest> | null;
    if (!body || typeof body !== "object") throw new HttpError("A locate request is required", 400);
    const { accountId } = await requireAccount(request, userId, "trade");
    const locate = await withAccountLock(userId, () => getBroker().createLocate(accountId, body as BrokerLocateRequest));
    return NextResponse.json<Locate>(locate, { status: 201 });
});
