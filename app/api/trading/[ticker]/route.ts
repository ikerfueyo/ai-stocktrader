import { NextResponse } from "next/server";
import { HttpError, withUser, type TickerContext } from "@/lib/server/errors";
import { fetchDailySeries, fetchPrices, fetchQuote } from "@/lib/server/alphaVantage";
import { assessTrade, computePositions, fillPrice, reducesPosition } from "@/lib/server/account";
import { getMarketStatus } from "@/lib/server/market";
import { enforceCollateral, getAccount, insertTrade, shortTickers, withAccountLock } from "@/lib/server/portfolio";
import { dayOrderExpiry, getOpenOrders, reservedCashFor } from "@/lib/server/orders";
import { toOrder } from "@/lib/orders";
import type { OrderRow, TradeRequest, TradeResponse } from "@/lib/types";

// Get stock data (Alpha Vantage API)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    return NextResponse.json(await fetchDailySeries(ticker, "full"));
});

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// Place a market order for a number of shares or a dollar amount. While the market is open, the server fills it at the current
// quote: buys at the ask, sells at the bid (fillPrice), stamped now; the response is { fill }, the executed trade. While it's closed,
// the order is queued for the open (a DAY market order in orders, filled by matchOrders) and the response is { order }.
// Covers and sales of longs are always allowed; anything that opens or adds to a position must leave no collateral shortfall
// (assessTrade, with the cash reserved for open orders unavailable; a queued order is checked at the current price). close: true
// (from the Portfolio page) rejects a trade that isn't on the closing side, or is larger than the open position, with 409, since a
// buy-in may have shrunk it, rather than flipping it; a dollar amount that covers the whole position closes it exactly. The buy-in
// check runs after the trade, so a cover meant to fix a shortfall goes through first.
export const POST = withUser(async (request, { params }: TickerContext, userId) => {
    const ticker = (await params).ticker.toUpperCase();
    const label = `POST /api/trading/${ticker}`;
    const body = await request.json().catch(() => null) as Partial<TradeRequest> | null;
    const { type, quantity: requestedShares, amount } = body?.order ?? {};
    const close = body?.close === true;
    if (type !== "BUY" && type !== "SELL") {
        throw new HttpError("Order type must be BUY or SELL", 400);
    }
    if (isPositive(requestedShares) === isPositive(amount)) {
        throw new HttpError("An order needs either a positive number of shares or a positive dollar amount", 400);
    }
    const market = await getMarketStatus();
    const result = await withAccountLock(userId, async (db): Promise<TradeResponse> => {
        const { transactions, splits, netTransfers, positions } = await getAccount(userId, db);
        const quote = await fetchQuote(ticker);
        const { price, fillPolicy } = market.open ? fillPrice(type, quote) : { price: quote.price, fillPolicy: "LAST" as const };
        const held = positions.find(position => position.ticker === ticker)?.quantity ?? 0;
        const closable = type === "SELL" ? Math.max(held, 0) : Math.max(-held, 0);
        const changedMessage = `Your ${ticker} position has changed (it may have been bought in to restore collateral). Refresh and try again.`;
        if (close && closable === 0) {
            throw new HttpError(changedMessage, 409);
        }
        const { quantity, total } = toOrder({
            mode: isPositive(amount) ? "dollars" : "shares",
            value: isPositive(amount) ? amount : requestedShares!,
            price,
            maxShares: close && isPositive(amount) ? closable : Infinity
        });
        if (!(quantity > 0)) {
            throw new HttpError("The order is too small to fill", 400);
        }
        const trade = { type, ticker, price, quantity, total };
        const reduces = reducesPosition({ positions, trade });
        if (close && !reduces) {
            throw new HttpError(changedMessage, 409);
        }
        if (!reduces) {
            // Collateral depends on the shorts' current prices, except the traded ticker's, which uses the fill price
            const { positions: after } = computePositions([...transactions, trade], splits);
            const { prices, staleTickers } = await fetchPrices(shortTickers(after).filter(symbol => symbol !== ticker), label);
            const reservedCash = await reservedCashFor(await getOpenOrders(userId, db), positions, label);
            const assessment = assessTrade({ transactions, splits, netTransfers, prices, staleTickers, trade, reservedCash });
            if (!assessment.allowed) {
                throw new HttpError(assessment.message, assessment.status);
            }
        }
        if (!market.open) {
            // A closing dollar amount that covers the whole position is queued as that many shares, so it still closes it exactly
            const queuedAmount = isPositive(amount) && !(close && quantity >= closable) ? amount : null;
            const { rows: [order] } = await db.query<OrderRow>(
                `INSERT INTO orders (user_id, ticker, side, order_type, quantity, amount, time_in_force, expires_at)
                 VALUES ($1, $2, $3, 'MARKET', $4, $5, 'DAY', $6) RETURNING *`,
                [userId, ticker, type, queuedAmount === null ? quantity : null, queuedAmount, dayOrderExpiry(market)]
            );
            return { order };
        }
        const fill = await insertTrade(db, userId, { ...trade, fillPolicy, quoteTime: quote.quoteTime });
        // The trade is already saved, so a failed buy-in check is only logged; the next GET /api/account runs it again
        await enforceCollateral(userId, label, db).catch(error => console.error(`${label}: buy-in check: ${error.message}`));
        return { fill };
    });
    return NextResponse.json<TradeResponse>(result);
});
