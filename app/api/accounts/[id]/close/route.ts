import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { withAccountLock } from "@/lib/server/portfolio";
import type { AccountContext } from "../route";

// Close the account. As with Alpaca, its positions must be closed, its open orders cancelled and its cash withdrawn first (409
// otherwise). The account's records stay; the user can then apply for a new one.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    await withAccountLock(userId, async () => {
        const broker = getBroker();
        const [positions, orders, trading] = await Promise.all([broker.listPositions(account_id), broker.listOrders(account_id, { status: "open" }), broker.getTradeAccount(account_id)]);
        if (positions.length > 0) throw new HttpError("Close your positions before closing the account", 409);
        if (orders.length > 0) throw new HttpError("Cancel your open orders before closing the account", 409);
        if (Math.abs(Number(trading.cash ?? 0) - Number(trading.pending_transfer_out ?? 0)) >= 0.01) throw new HttpError("Withdraw your cash before closing the account", 409);
        await getBroker().closeAccount(account_id);
    });
    return new NextResponse(null, { status: 204 });
});
