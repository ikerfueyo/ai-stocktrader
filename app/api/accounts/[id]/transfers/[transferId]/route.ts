import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { forgetBrokerLedger } from "@/lib/server/portfolio";

interface TransferContext {
    params: Promise<{ id: string; transferId: string }>;
}

// Cancel a transfer while it's still QUEUED (422 once it's gone to clearing). A deposit's instant credit is taken back.
export const DELETE = withUser(async (request, { params }: TransferContext, userId) => {
    const { id, transferId } = await params;
    const { account_id } = await findUserAccount(userId, id);
    await getBroker().cancelTransfer(account_id, transferId);
    forgetBrokerLedger(account_id);
    return new NextResponse(null, { status: 204 });
});
