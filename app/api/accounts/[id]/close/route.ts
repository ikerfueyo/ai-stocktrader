import { NextResponse } from "next/server";
import { requireRecentSignIn } from "@/lib/server/sensitive";
import { HttpError, withUser } from "@/lib/server/errors";
import { closeAccountProblem } from "@/lib/accounts";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { withAccountLock } from "@/lib/server/portfolio";
import type { AccountContext } from "../route";

// Close the account once closeAccountProblem finds nothing in the way (409 otherwise). The account's records stay; the user can
// then apply for a new one.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    await requireRecentSignIn(userId);
    await withAccountLock(userId, async () => {
        const broker = getBroker();
        const [positions, orders, trading] = await Promise.all([broker.listPositions(account_id), broker.listOrders(account_id, { status: "open" }), broker.getTradeAccount(account_id)]);
        const problem = closeAccountProblem({ positions: positions.length, openOrders: orders.length, cash: trading.cash, pendingTransferOut: trading.pending_transfer_out });
        if (problem) throw new HttpError(problem, 409);
        await getBroker().closeAccount(account_id);
    });
    return new NextResponse(null, { status: 204 });
});
