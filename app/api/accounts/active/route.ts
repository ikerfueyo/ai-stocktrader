import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { ACTIVE_ACCOUNT_COOKIE, findUserAccount } from "@/lib/server/brokerAccounts";

// Choose which of the user's accounts requests act on (the header's switcher): body { accountId }, kept in a cookie for a year
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { accountId?: unknown } | null;
    if (typeof body?.accountId !== "string") throw new HttpError("accountId is required", 400);
    const { account_id } = await findUserAccount(userId, body.accountId);
    const response = new NextResponse(null, { status: 204 });
    response.cookies.set(ACTIVE_ACCOUNT_COOKIE, account_id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86400 });
    return response;
});
