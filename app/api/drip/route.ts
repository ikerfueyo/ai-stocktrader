import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";
import { getDripSettings, setDripSetting } from "@/lib/server/automation/drip";

const accountFor = async (userId: string) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) throw new HttpError("Open an account to reinvest dividends", 403);
    return accountId;
};

// Dividend reinvestment on the user's account: its default, each long position's choice, what's held under $1 and recent dividends
export const GET = withUser(async (request, context, userId) => NextResponse.json(await getDripSettings(await accountFor(userId))));

// Body { enabled } for the account's default, or { symbol, enabled: true | false | null } for a position (null follows the default)
export const PUT = withUser(async (request, context, userId) => {
    const accountId = await accountFor(userId);
    const body = await request.json().catch(() => null) as { symbol?: unknown; enabled?: unknown } | null;
    const symbol = typeof body?.symbol === "string" && body.symbol.trim() ? body.symbol.trim().toUpperCase() : null;
    if (!body || !(typeof body.enabled === "boolean" || (symbol && body.enabled === null))) throw new HttpError("enabled must be true or false (or null for a position)", 400);
    await setDripSetting(accountId, symbol, body.enabled as boolean | null);
    return NextResponse.json(await getDripSettings(accountId));
});
