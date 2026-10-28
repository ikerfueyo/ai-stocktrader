import { NextResponse } from "next/server";
import { requireTradableStock } from "@/lib/server/assets";
import { requireAccount } from "@/lib/server/brokerAccounts";
import { getBroker } from "@/lib/server/broker";
import { HttpError, withUser } from "@/lib/server/errors";
import { isForeignListing } from "@/lib/server/marketData";
import { enforceCollateral, ledgerAccountId, withAccountLock, withReasons } from "@/lib/server/portfolio";
import type { AppOrder, BrokerOrderRequest } from "@/lib/types";

// Place an order on the active account: Alpaca's CreateOrderRequest (symbol, side, type, time_in_force, qty or notional, prices,
// extended_hours, order_class with take_profit and stop_loss, position_intent, client_order_id). The broker checks it against its
// rules and buying power (403 or 422 with its reason), stores it and matches it at once, so a marketable order during its session
// comes back filled; one placed outside its session is accepted for the open. A fill runs the buy-in check after it.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<BrokerOrderRequest> | null;
    if (!body || typeof body !== "object") throw new HttpError("An order is required", 400);
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    if (isForeignListing(symbol)) throw new HttpError("Only U.S. listings can be traded", 400);
    if (symbol) await requireTradableStock(symbol);
    const { accountId } = await requireAccount(request, userId, "trade");
    const label = `POST /api/orders ${symbol}`;
    const order = await withAccountLock(userId, async db => {
        const placed = await getBroker().createOrder(accountId, { ...body, symbol } as BrokerOrderRequest);
        // The fill is already saved, so a failed buy-in check is only logged; the next GET /api/account runs it again
        if (Number(placed.filled_qty) > 0) await enforceCollateral(userId, label, db).catch(error => console.error(`${label}: buy-in check: ${error.message}`));
        return placed;
    });
    return NextResponse.json<AppOrder>((await withReasons([order]))[0], { status: 201 });
});

// The account's orders, newest first, with bracket, OCO and OTO legs nested under their parent: ?status=open (the default), closed
// or all; ?symbols= (or ?ticker=) to filter; ?limit= up to 500 (default 100)
export const GET = withUser(async (request, context, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) return NextResponse.json<AppOrder[]>([]);
    const params = request.nextUrl.searchParams;
    const status = params.get("status");
    const orders = await getBroker().listOrders(accountId, {
        status: status === "all" || status === "closed" ? status : "open",
        symbols: params.get("symbols") ?? params.get("ticker")?.toUpperCase() ?? undefined,
        limit: Number(params.get("limit") ?? 100),
        nested: true
    });
    return NextResponse.json<AppOrder[]>(await withReasons(orders));
});

// Cancel every open order: [{ id, status }] per order, as Alpaca answers
export const DELETE = withUser(async (request, context, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) return NextResponse.json([]);
    return NextResponse.json(await withAccountLock(userId, () => getBroker().cancelAllOrders(accountId)));
});
