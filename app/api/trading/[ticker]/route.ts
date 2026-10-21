import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser, type TickerContext } from "@/lib/server/errors";
import { fetchDailySeries, fetchPrices } from "@/lib/server/alphaVantage";
import { assessTrade, computePositions, reducesPosition } from "@/lib/server/account";
import { enforceCollateral, getAccount, shortTickers, withAccountLock } from "@/lib/server/portfolio";
import type { TradeRequest, TransactionRow } from "@/lib/types";

// Get stock data (Alpha Vantage API)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    return NextResponse.json(await fetchDailySeries(ticker, "full"));
});

// Create a transaction. Covers and sales of longs are always allowed; anything that opens or adds to a position must leave no
// collateral shortfall (assessTrade). close: true (from the Portfolio page) rejects a trade larger than the open position with 409,
// since a buy-in may have shrunk it, rather than flipping it to the other side. The buy-in check runs after the trade, so a cover
// meant to fix a shortfall goes through first.
export const POST = withUser(async (request, { params }: TickerContext, userId) => {
    const { ticker: routeTicker } = await params;
    const { transaction, close = false } = await request.json() as TradeRequest;
    const { date, type, ticker, price, quantity, total } = transaction;
    const trade = { type, ticker: String(ticker), price, quantity, total };
    const inserted = await withAccountLock(userId, async () => {
        const { transactions, netTransfers, positions } = await getAccount(userId);
        const reduces = reducesPosition({ positions, trade });
        if (close && !reduces) {
            throw new HttpError(`Your ${trade.ticker.toUpperCase()} position has changed (it may have been bought in to restore collateral). Refresh and try again.`, 409);
        }
        if (!reduces) {
            // Collateral depends on the shorts' current prices, except the traded ticker's, which uses the trade price
            const { positions: after } = computePositions([...transactions, trade]);
            const { prices, staleTickers } = await fetchPrices(shortTickers(after).filter(symbol => symbol !== trade.ticker.toUpperCase()), `POST /api/trading/${routeTicker}`);
            const assessment = assessTrade({ transactions, netTransfers, prices, staleTickers, trade });
            if (!assessment.allowed) {
                throw new HttpError(assessment.message, assessment.status);
            }
        }
        const { rows } = await pool.query<TransactionRow>(
            'INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [userId, date, type, ticker, price, quantity, total]
        );
        // The trade is already saved, so a failed buy-in check is only logged; the next GET /api/account runs it again
        await enforceCollateral(userId, `POST /api/trading/${routeTicker}`).catch(error => console.error(`POST /api/trading/${routeTicker}: buy-in check: ${error.message}`));
        return rows[0];
    });
    return NextResponse.json(inserted);
});
