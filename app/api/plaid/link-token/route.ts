import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getPlaid } from "@/lib/server/broker/alpaca";

// A Plaid Link token for the signed-in user, to open Plaid Link and pick the bank to link (POST /api/accounts/[id]/ach then takes
// its public token). 404 when Plaid isn't configured: banks are linked by routing and account number.
export const POST = withUser(async (request, context, userId) => {
    const plaid = getPlaid();
    if (!plaid) throw new HttpError("Plaid isn't set up", 404);
    const { link_token, expiration } = await plaid.createLinkToken(userId);
    return NextResponse.json<{ linkToken: string; expiration: string }>({ linkToken: link_token, expiration });
});
