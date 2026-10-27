import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";

interface BankContext {
    params: Promise<{ id: string; bankId: string }>;
}

// Remove a wire recipient bank
export const DELETE = withUser(async (request, { params }: BankContext, userId) => {
    const { id, bankId } = await params;
    const { account_id } = await findUserAccount(userId, id);
    await getBroker().deleteRecipientBank(account_id, bankId);
    return new NextResponse(null, { status: 204 });
});
