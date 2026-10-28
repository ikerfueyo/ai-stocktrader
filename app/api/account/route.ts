import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { valueAccount } from "@/lib/server/account";
import { getAccount, getFills, withAccountLock } from "@/lib/server/portfolio";
import { updateAccount } from "@/lib/server/upkeep";
import { marginSnapshot } from "@/lib/server/broker/sim/marginAccount";
import { accruedInterest, MARGIN_RATE } from "@/lib/server/broker/sim/calls";
import { needsImmediateLiquidation } from "@/lib/server/broker/sim/margin";
import type { Account } from "@/lib/types";

const LIQUIDATION_RATIO = Number(process.env.SIM_LIQUIDATION_RATIO ?? 0.75);

// The account for the header and the margin panel: the broker's margin figures (buying power, equity, initial and maintenance margin,
// the debit and its interest, open calls, whether it may short), unrealized and realized P&L, what's withdrawable and settling, and
// the past week's liquidations (Alpha Vantage API, one call per position, shared with /api/portfolio by the price cache). Posts paid
// dividends and runs the margin check first.
export const GET = withUser(async (request, context, userId) => {
    await withAccountLock(userId, db => updateAccount(userId, "GET /api/account", db));
    const { accountId, positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledProceeds, accruedFees } = await getAccount(userId);
    const liquidations = (await getFills(userId, { since: new Date(Date.now() - 7 * 86400000) })).filter(({ reason }) => reason === "LIQUIDATION").slice(0, 20);
    const ledger = {
        realizedPnl, netDividends, pendingTransferOut, unsettledProceeds, liquidations,
        accruedFees: Math.round((accruedFees.REG + accruedFees.TAF + accruedFees.CAT) * 100) / 100,
        positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity }))
    };
    if (!accountId) {
        return NextResponse.json<Account>({
            ...ledger, totalCash, buyingPower: 0, regtBuyingPower: 0, nonMarginableBuyingPower: 0, reservedCash: 0, multiplier: 1, maxMultiplier: 1, equity: totalCash,
            longMarketValue: 0, shortMarketValue: 0, initialMargin: 0, maintenanceMargin: 0, excessLiquidity: totalCash, sma: 0, debitBalance: 0, marginRate: MARGIN_RATE,
            accruedInterest: 0, marginStatus: "ok", marginCalls: [], shortingEnabled: false, shortingBlockedReason: "Open an account first", unrealizedPnl: 0,
            missingPrices: [], withdrawableCash: 0
        });
    }
    const [snapshot, interest] = await Promise.all([marginSnapshot(pool, accountId), accruedInterest(accountId)]);
    const { state } = snapshot;
    const prices = Object.fromEntries(snapshot.positions.map(({ symbol, price }) => [symbol, price]));
    const { unrealizedPnl, missingPrices } = valueAccount({ positions, totalCash, prices, staleTickers: snapshot.staleTickers });
    const liquidating = needsImmediateLiquidation(state, LIQUIDATION_RATIO);
    return NextResponse.json<Account>({
        ...ledger,
        totalCash: snapshot.cash,
        buyingPower: state.buyingPower,
        regtBuyingPower: state.regtBuyingPower,
        nonMarginableBuyingPower: state.nonMarginableBuyingPower,
        reservedCash: snapshot.reserved,
        multiplier: state.multiplier,
        maxMultiplier: state.maxMultiplier,
        equity: state.equity,
        longMarketValue: state.longMarketValue,
        shortMarketValue: state.shortMarketValue,
        initialMargin: state.initialMargin,
        maintenanceMargin: state.maintenanceMargin,
        excessLiquidity: state.excessLiquidity,
        sma: state.sma,
        debitBalance: state.debit,
        marginRate: MARGIN_RATE,
        accruedInterest: interest,
        marginStatus: liquidating ? "liquidation" : snapshot.calls.length > 0 ? "margin_call" : "ok",
        marginCalls: snapshot.calls.map(call => ({
            id: call.id, type: call.type, amount: Number(call.amount), date: call.date, issuedAt: call.issued_at.toISOString(), dueAt: call.due_at.toISOString()
        })),
        shortingEnabled: snapshot.shortingBlocked === null,
        shortingBlockedReason: snapshot.shortingBlocked,
        unrealizedPnl,
        missingPrices,
        withdrawableCash: snapshot.withdrawable
    });
});
