import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { fetchPrices } from "@/lib/server/marketData";
import { valueAccount } from "@/lib/server/account";
import { getAccount, withAccountLock } from "@/lib/server/portfolio";
import { updateAccount } from "@/lib/server/upkeep";
import { getOpenOrders, reservedCashFor } from "@/lib/server/orders";
import type { Account, TransactionRow } from "@/lib/types";

// Get total, available, restricted and reserved (for open orders) cash, collateral status, equity and unrealized P&L, plus the past week's buy-in trades
// (Alpha Vantage API, one call per position, shared with /api/portfolio by the price cache). Posts paid dividends and runs the
// collateral buy-in check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, db => updateAccount(userId, "GET /api/account", db));
    const { positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledInstant } = await getAccount(userId);
    const [{ prices, staleTickers }, orders] = await Promise.all([fetchPrices(positions.map(({ ticker }) => ticker), "GET /api/account"), getOpenOrders(userId, pool)]);
    const reservedCash = await reservedCashFor(orders, positions, "GET /api/account");
    const { rows: liquidations } = await pool.query<TransactionRow>(
        `SELECT * FROM transactions WHERE user_id = $1 AND reason = 'LIQUIDATION' AND "date" > now() - interval '7 days' ORDER BY "date" DESC, id DESC LIMIT 20`,
        [userId]
    );
    const valuation = valueAccount({ positions, totalCash, prices, staleTickers, reservedCash });
    return NextResponse.json<Account>({
        ...valuation,
        pendingTransferOut,
        withdrawableCash: Math.max(0, Math.round((valuation.availableCash - unsettledInstant) * 100) / 100),
        realizedPnl,
        netDividends,
        positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity })),
        liquidations
    });
});
