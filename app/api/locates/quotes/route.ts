import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { HttpError, withUser } from "@/lib/server/errors";
import { isHttpError } from "@/lib/server/httpError";
import { ledgerAccountId } from "@/lib/server/portfolio";
import type { ListLocateQuotesResponse } from "@/lib/types";

// The locate fee and shares available for hard-to-borrow symbols (?symbols=AAA,BBB); advisory, nothing is reserved. None from a
// broker that doesn't offer locates (Alpaca's Broker API: 501).
export const GET = withUser(async (request, context, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) throw new HttpError("Open an account first", 403);
    const symbols = (request.nextUrl.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    if (symbols.length === 0) throw new HttpError("symbols is required", 400);
    return NextResponse.json<ListLocateQuotesResponse>(await getBroker().listLocateQuotes(accountId, symbols).catch(error => {
        if (isHttpError(error) && error.status === 501) return { quotes: [] };
        throw error;
    }));
});
