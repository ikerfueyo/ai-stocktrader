import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { getAccount as getLedger, withAccountLock } from "@/lib/server/portfolio";
import type { AccountContext } from "../route";

// Close the account. As with Alpaca, its positions must be closed, its open orders cancelled and its cash withdrawn first (409
// otherwise). The account's records stay; the user can then apply for a new one.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    await withAccountLock(userId, async db => {
        const [{ positions, totalCash }, orders] = await Promise.all([getLedger(userId, db), getBroker().listOrders(account_id, { status: "open" })]);
        if (positions.length > 0) throw new HttpError("Close your positions before closing the account", 409);
        if (orders.length > 0) throw new HttpError("Cancel your open orders before closing the account", 409);
        if (Math.abs(totalCash) >= 0.01) throw new HttpError("Withdraw your cash before closing the account", 409);
        await getBroker().closeAccount(account_id);
    });
    return new NextResponse(null, { status: 204 });
});
