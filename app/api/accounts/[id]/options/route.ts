import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { OptionsApprovalResponse } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's options approval requests, newest first
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<OptionsApprovalResponse[]>(await getBroker().listOptionsApprovals(account_id));
});

// Ask for options trading at a level: body { level } (1 covered calls and cash-secured puts, 2 buying calls and puts, 3 spreads).
// It needs the options agreement (PATCH the account's agreements first); the broker decides in a few seconds, approving a lower
// level when the experience given doesn't support it.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as { level?: unknown } | null;
    const level = body?.level;
    if (level !== 1 && level !== 2 && level !== 3) throw new HttpError("level must be 1, 2 or 3", 400);
    return NextResponse.json<OptionsApprovalResponse>(await getBroker().requestOptionsApproval(account_id, { level }), { status: 201 });
});
