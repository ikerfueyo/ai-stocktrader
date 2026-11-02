import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { openIra } from "@/lib/server/ira";
import type { BrokerAccount, OpenIraRequest } from "@/lib/types";

// Open a traditional or Roth IRA from the user's individual account (Alpaca's shared KYC): body OpenIraRequest (the type, the tax ID
// again, beneficiaries, the agreements and the IRA disclosure accepted). 201 with the new account, under review like any application;
// 409 without an active individual account or with an open IRA of that type.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<OpenIraRequest> | null;
    if (!body || typeof body !== "object") throw new HttpError("An IRA application is required", 400);
    return NextResponse.json<BrokerAccount>(await openIra(request, userId, body), { status: 201 });
});
