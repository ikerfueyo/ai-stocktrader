import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { fetchPrices } from "@/lib/server/alphaVantage";
import { valueAccount } from "@/lib/server/account";
import { enforceCollateral, getAccount, withAccountLock } from "@/lib/server/portfolio";
import type { Account, TransactionRow } from "@/lib/types";

// Get total, available and restricted cash, collateral status, equity and unrealized P&L, plus the past week's buy-in trades
// (Alpha Vantage API, one call per position, shared with /api/portfolio by the price cache). Runs the collateral buy-in check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, () => enforceCollateral(userId, "GET /api/account"));
    const { positions, totalCash } = await getAccount(userId);
    const { prices, staleTickers } = await fetchPrices(positions.map(({ ticker }) => ticker), "GET /api/account");
    const { rows: liquidations } = await pool.query<TransactionRow>(
        `SELECT * FROM transactions WHERE user_id = $1 AND reason = 'LIQUIDATION' AND "date" > now() - interval '7 days' ORDER BY "date" DESC, id DESC LIMIT 20`,
        [userId]
    );
    return NextResponse.json<Account>({
        ...valueAccount({ positions, totalCash, prices, staleTickers }),
        positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity })),
        liquidations
    });
});
