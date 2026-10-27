import { NextResponse } from "next/server";
import { requireTradableStock } from "@/lib/server/assets";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { fetchPrices, fetchQuote, isForeignListing } from "@/lib/server/marketData";
import { assessTrade, computePositions, reducesPosition, roundCents, roundPrice } from "@/lib/server/account";
import { stopReached } from "@/lib/server/orderMatching";
import { getMarketStatus } from "@/lib/server/market";
import { dayOrderExpiry, getOpenOrders, matchOrders, reservedCashFor } from "@/lib/server/orders";
import { getAccount, shortTickers, withAccountLock } from "@/lib/server/portfolio";
import { roundShares } from "@/lib/orders";
import type { OrderRequest, OrderRow } from "@/lib/types";

const ORDER_TYPES = ["LIMIT", "STOP", "STOP_LIMIT"];
const TICKER = /^[A-Z0-9.\-]{1,15}$/;
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// Place a limit, stop or stop-limit order for a number of shares, good for the day (DAY: until the close of the current session, or
// the next one while the market is closed) or until cancelled (GTC). Accepted at any time; it can only fill while the market is
// open. A stop must be on the right side of the current price (above it for a buy, below for a sell), or it would trigger at
// once. An order that opens or adds to a position is checked as if it filled at its limit (or stop) price, with the cash reserved
// for the other open orders unavailable, and then reserves its own. If it's marketable and the market is open, it fills right away.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<OrderRequest> | null;
    const { ticker: rawTicker, side, orderType, quantity: rawQuantity, limitPrice: rawLimit, stopPrice: rawStop, timeInForce } = body?.order ?? {};
    const ticker = String(rawTicker ?? "").toUpperCase();
    if (!TICKER.test(ticker)) throw new HttpError("A valid ticker is required", 400);
    if (isForeignListing(ticker)) throw new HttpError("Only U.S. listings can be traded", 400);
    await requireTradableStock(ticker);
    if (side !== "BUY" && side !== "SELL") throw new HttpError("Side must be BUY or SELL", 400);
    if (!orderType || !ORDER_TYPES.includes(orderType)) throw new HttpError("Order type must be LIMIT, STOP or STOP_LIMIT (market orders go to /api/trading)", 400);
    if (timeInForce !== "DAY" && timeInForce !== "GTC") throw new HttpError("Time in force must be DAY or GTC", 400);
    if (!isPositive(rawQuantity)) throw new HttpError("Quantity must be a positive number of shares", 400);
    const needsLimit = orderType !== "STOP";
    const needsStop = orderType !== "LIMIT";
    if (needsLimit && !isPositive(rawLimit)) throw new HttpError("A limit price is required", 400);
    if (needsStop && !isPositive(rawStop)) throw new HttpError("A stop price is required", 400);
    const quantity = roundShares(rawQuantity);
    const limitPrice = needsLimit ? roundPrice(rawLimit!) : null;
    const stopPrice = needsStop ? roundPrice(rawStop!) : null;
    if (!(quantity > 0)) throw new HttpError("Quantity must be at least 0.000001 shares", 400);
    const label = `POST /api/orders ${ticker}`;
    const market = await getMarketStatus();

    const order = await withAccountLock(userId, async db => {
        const quote = await fetchQuote(ticker);
        if (stopPrice !== null && stopReached(side, stopPrice, quote.price)) {
            throw new HttpError(`A ${side === "BUY" ? "buy" : "sell"} stop must be ${side === "BUY" ? "above" : "below"} the current price (${quote.price})`, 400);
        }
        const { transactions, splits, netTransfers, positions } = await getAccount(userId, db);
        const price = limitPrice ?? stopPrice!;
        const trade = { type: side, ticker, price, quantity, total: roundCents(quantity * price) };
        if (!reducesPosition({ positions, trade })) {
            const { positions: after } = computePositions([...transactions, trade], splits);
            const { prices, staleTickers } = await fetchPrices(shortTickers(after).filter(symbol => symbol !== ticker), label);
            const reservedCash = await reservedCashFor(await getOpenOrders(userId, db), positions, label);
            const assessment = assessTrade({ transactions, splits, netTransfers, prices, staleTickers, trade, reservedCash });
            if (!assessment.allowed) throw new HttpError(assessment.message, assessment.status);
        }
        const { rows: [inserted] } = await db.query<OrderRow>(
            `INSERT INTO orders (user_id, ticker, side, order_type, quantity, limit_price, stop_price, time_in_force, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [userId, ticker, side, orderType, quantity, limitPrice, stopPrice, timeInForce, timeInForce === "DAY" ? dayOrderExpiry(market) : null]
        );
        if (market.open) await matchOrders(userId, label, db);
        return (await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [inserted.id])).rows[0];
    });
    return NextResponse.json<{ order: OrderRow }>({ order });
});

// Get the user's orders, newest first: ?status=open for the open ones (checked against current prices first, so fills and expiries
// show up), or all of them. ?ticker= filters to one ticker.
export const GET = withUser(async (request, context, userId) => {
    const status = request.nextUrl.searchParams.get("status") === "open" ? "open" : "all";
    const ticker = request.nextUrl.searchParams.get("ticker")?.toUpperCase() ?? null;
    if (status === "open") {
        await withAccountLock(userId, db => matchOrders(userId, "GET /api/orders", db));
    }
    const { rows } = await pool.query<OrderRow>(
        `SELECT o.*, t.id AS transaction_id FROM orders o LEFT JOIN transactions t ON t.order_id = o.id
         WHERE o.user_id = $1 AND ($2 = 'all' OR o.status = 'OPEN') AND ($3::text IS NULL OR o.ticker = $3)
         ORDER BY o.created_at DESC, o.id DESC LIMIT 500`,
        [userId, status, ticker]
    );
    return NextResponse.json(rows);
});
