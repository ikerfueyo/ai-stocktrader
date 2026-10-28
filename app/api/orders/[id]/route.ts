import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { orderFillRows } from "@/lib/server/brokerLedger";
import { listOrderFills } from "@/lib/server/broker/sim/orders";
import { HttpError, withUser } from "@/lib/server/errors";
import { forgetBrokerLedger, ledgerAccountId, readsThroughBroker, toTransactionRow, withAccountLock, withReasons } from "@/lib/server/portfolio";
import type { AppOrder, BrokerOrderUpdate, OrderDetails } from "@/lib/types";

interface OrderContext {
    params: Promise<{ id: string }>;
}

const accountFor = async (userId: string) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) throw new HttpError("Order not found", 404);
    return accountId;
};

// One of the account's orders with its legs, and its fills (with those of the orders it replaced), for the order details
export const GET = withUser(async (request, { params }: OrderContext, userId) => {
    const accountId = await accountFor(userId);
    const { id } = await params;
    const [order, fills] = await Promise.all([
        getBroker().getOrder(accountId, id),
        !readsThroughBroker() ? listOrderFills(accountId, id).then(rows => rows.map(row => toTransactionRow(row, userId))) : orderFillRows(getBroker(), accountId, id, userId)
    ]);
    return NextResponse.json<OrderDetails>({ order: (await withReasons([order]))[0], fills });
});

// Replace an open order (Alpaca's UpdateOrderRequest: qty, limit_price, stop_price, trail, time_in_force): the reply is the new order,
// which replaces it
export const PATCH = withUser(async (request, { params }: OrderContext, userId) => {
    const accountId = await accountFor(userId);
    const { id } = await params;
    const update = await request.json().catch(() => null) as BrokerOrderUpdate | null;
    const order = await withAccountLock(userId, () => getBroker().replaceOrder(accountId, id, update ?? {}));
    forgetBrokerLedger(accountId);
    return NextResponse.json<AppOrder>((await withReasons([order]))[0]);
});

// Cancel an open order (with the rest of its bracket, OCO or OTO group); 404 if it isn't the user's, 422 once it's no longer open
export const DELETE = withUser(async (request, { params }: OrderContext, userId) => {
    const accountId = await accountFor(userId);
    const { id } = await params;
    await withAccountLock(userId, () => getBroker().cancelOrder(accountId, id));
    forgetBrokerLedger(accountId);
    return new NextResponse(null, { status: 204 });
});
