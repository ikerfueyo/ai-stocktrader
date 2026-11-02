import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { CreateBankRequest } from "@/lib/server/broker/types";
import type { RecipientBank } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the banks the account can wire money out to, newest first (account numbers masked)
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<RecipientBank[]>(await getBroker().listRecipientBanks(account_id));
});

// Add one: body { name, bank_code (an ABA routing number), account_number }. Only domestic wires are offered.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as Partial<CreateBankRequest> | null;
    if (!body || typeof body !== "object") throw new HttpError("A bank is required", 400);
    return NextResponse.json<RecipientBank>(await getBroker().createRecipientBank(account_id, {
        name: String(body.name ?? ""), bank_code: String(body.bank_code ?? ""), bank_code_type: "ABA", account_number: String(body.account_number ?? "")
    }), { status: 201 });
});
