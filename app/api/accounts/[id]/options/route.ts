import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { isHttpError } from "@/lib/server/httpError";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { optionsSuitabilityErrors, type AccountApplication } from "@/lib/kyc";
import type { OptionsApprovalResponse } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's options approval requests, newest first; none when the broker refuses to list them (403), as Alpaca does for a
// correspondent without options ("us_option is not enabled for correspondent"), so the rest of Settings still loads
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<OptionsApprovalResponse[]>(await getBroker().listOptionsApprovals(account_id).catch(error => {
        if (isHttpError(error) && error.status === 403) return [];
        throw error;
    }));
});

// Ask for options trading at a level: body { level } (1 covered calls and cash-secured puts, 2 buying calls and puts, 3 spreads).
// It needs the options agreement and, in the account's identity, the options experience, annual income and the suitability answers
// Alpaca requires (PATCH the account first; 400 without them); the broker decides in a few seconds, approving a lower level when
// the experience given doesn't support it.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as { level?: unknown } | null;
    const level = body?.level;
    if (level !== 1 && level !== 2 && level !== 3) throw new HttpError("level must be 1, 2 or 3", 400);
    const broker = getBroker();
    const missing = Object.values(optionsSuitabilityErrors(((await broker.getAccount(account_id)).identity ?? {}) as AccountApplication["identity"]));
    if (missing.length > 0) throw new HttpError(`Answer the options questions first: ${missing.join("; ")}`, 400);
    return NextResponse.json<OptionsApprovalResponse>(await broker.requestOptionsApproval(account_id, { level }), { status: 201 });
});
