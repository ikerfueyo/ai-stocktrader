import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { fetchPrices } from "@/lib/server/marketData";
import { valueAccount } from "@/lib/server/account";
import { getAccount, getFills, withAccountLock } from "@/lib/server/portfolio";
import { updateAccount } from "@/lib/server/upkeep";
import { reservedCash as reservedForOrders } from "@/lib/server/broker/sim/orders";
import type { Account } from "@/lib/types";

// Get total, available, restricted and reserved (for open orders) cash, collateral status, equity and unrealized P&L, plus the past week's buy-in trades
// (Alpha Vantage API, one call per position, shared with /api/portfolio by the price cache). Posts paid dividends and runs the
// collateral buy-in check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, db => updateAccount(userId, "GET /api/account", db));
    const { accountId, positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledInstant, unsettledProceeds, accruedFees } = await getAccount(userId);
    const [{ prices, staleTickers }, reservedCash] = await Promise.all([
        fetchPrices(positions.map(({ ticker }) => ticker), "GET /api/account"),
        accountId ? reservedForOrders(pool, accountId, positions) : 0
    ]);
    const liquidations = (await getFills(userId, { since: new Date(Date.now() - 7 * 86400000) })).filter(({ reason }) => reason === "LIQUIDATION").slice(0, 20);
    const valuation = valueAccount({ positions, totalCash, prices, staleTickers, reservedCash });
    return NextResponse.json<Account>({
        ...valuation,
        pendingTransferOut,
        withdrawableCash: Math.max(0, Math.round((valuation.availableCash - unsettledInstant - unsettledProceeds) * 100) / 100),
        unsettledProceeds,
        accruedFees: Math.round((accruedFees.REG + accruedFees.TAF + accruedFees.CAT) * 100) / 100,
        realizedPnl,
        netDividends,
        positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity })),
        liquidations
    });
});
