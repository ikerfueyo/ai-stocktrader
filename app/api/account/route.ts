import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import { valueAccount } from "@/lib/server/account";
import { brokerLedger, forgetBrokerLedger, getAccount, getFills, ledgerAccountId, readsThroughBroker, withAccountLock } from "@/lib/server/portfolio";
import { getBroker } from "@/lib/server/broker";
import { accountSummary, flattenOrders, openOrderReservation, unpricedSymbols } from "@/lib/server/brokerLedger";
import { fetchPrices } from "@/lib/server/marketData";
import { findAsset } from "@/lib/server/assets";
import type { Order as BrokerOrder } from "@/lib/server/broker/types";
import { updateAccount } from "@/lib/server/upkeep";
import { marginSnapshot, maxMultiplierOf } from "@/lib/server/broker/sim/marginAccount";
import { accruedInterest, MARGIN_RATE } from "@/lib/server/broker/sim/calls";
import { needsImmediateLiquidation } from "@/lib/server/broker/sim/margin";
import type { Account } from "@/lib/types";

const LIQUIDATION_RATIO = Number(process.env.SIM_LIQUIDATION_RATIO ?? 0.75);
// Alpaca's margin rate isn't in its API: ALPACA_MARGIN_RATE (annual), the simulator's by default
const ALPACA_MARGIN_RATE = Number(process.env.ALPACA_MARGIN_RATE ?? MARGIN_RATE);

// What open orders hold back from buying power, shown under Buying power: quotes only for market orders and short sales, and each
// symbol's marginable flag from the universe. A quote that can't be fetched leaves those orders out rather than failing the account.
const heldForOrders = async (orders: BrokerOrder[], positions: { ticker: string; quantity: number }[], multiplier: number) => {
    if (orders.length === 0) return 0;
    const unpriced = unpricedSymbols(orders);
    const symbols = [...new Set(flattenOrders(orders).map(({ symbol }) => String(symbol)))];
    const [quotes, assets] = await Promise.all([
        unpriced.length > 0 ? fetchPrices(unpriced, "Account").then(({ quotes }) => quotes).catch(() => ({})) : {},
        Promise.all(symbols.map(async symbol => [symbol, (await findAsset(symbol))?.marginable ?? null] as const))
    ]);
    return openOrderReservation(orders, Object.fromEntries(positions.map(({ ticker, quantity }) => [ticker, quantity])), quotes, { marginable: Object.fromEntries(assets), multiplier });
};

// The account for the header and the margin panel: the broker's margin figures (buying power, equity, initial and maintenance margin,
// the debit and its interest, open calls, whether it may short), unrealized and realized P&L, what's withdrawable and settling, and
// the past week's liquidations (Alpha Vantage API, one call per position, shared with /api/portfolio by the price cache). Posts paid
// dividends and runs the margin check first. With Alpaca, the figures are its trading account's (lib/server/brokerLedger.ts).
export const GET = withUser(async (request, context, userId) => {
    if (readsThroughBroker()) {
        const accountId = await ledgerAccountId(userId);
        if (accountId) {
            // Always fresh: the header reloads it after every change
            forgetBrokerLedger(accountId);
            const [{ trade, positions, ledger }, configurations, orders] = await Promise.all([
                brokerLedger(accountId), getBroker().getConfigurations(accountId), getBroker().listOrders(accountId, { status: "open", nested: true } as never)
            ]);
            const reservedCash = await heldForOrders(orders, ledger.positions, Number(trade.multiplier ?? 1));
            return NextResponse.json<Account>(accountSummary({ trade, positions, configurations, ledger, marginRate: ALPACA_MARGIN_RATE, reservedCash }));
        }
    }
    await withAccountLock(userId, db => updateAccount(userId, "GET /api/account", db));
    const { accountId, positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledProceeds, accruedFees } = await getAccount(userId);
    const liquidations = (await getFills(userId, { since: new Date(Date.now() - 7 * 86400000) })).filter(({ reason }) => reason === "LIQUIDATION").slice(0, 20);
    const ledger = {
        realizedPnl, netDividends, pendingTransferOut, unsettledProceeds, liquidations,
        accruedFees: Math.round(Object.values(accruedFees).reduce((sum, amount) => sum + amount, 0) * 100) / 100,
        positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity }))
    };
    if (!accountId) {
        return NextResponse.json<Account>({
            ...ledger, totalCash, buyingPower: 0, regtBuyingPower: 0, nonMarginableBuyingPower: 0, reservedCash: 0, multiplier: 1, maxMultiplier: 1, equity: totalCash,
            longMarketValue: 0, shortMarketValue: 0, initialMargin: 0, maintenanceMargin: 0, excessLiquidity: totalCash, sma: 0, debitBalance: 0, marginRate: MARGIN_RATE,
            accruedInterest: 0, marginStatus: "ok", marginCalls: [], intradayDeficits: [], marginRestrictedUntil: null, belowMaintenance: null, shortingEnabled: false, shortingBlockedReason: "Open an account first", unrealizedPnl: 0,
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
        // The account's own, which a 90-day intraday margin restriction holds at 1x for now
        maxMultiplier: maxMultiplierOf(snapshot.row),
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
        intradayDeficits: snapshot.intradayDeficits.map(deficit => ({
            id: deficit.id, date: deficit.date, amount: Number(deficit.amount), deMinimis: deficit.de_minimis, missed: deficit.missed, restrictOn: deficit.restrict_on, expireOn: deficit.expire_on
        })),
        marginRestrictedUntil: snapshot.restrictedUntil,
        belowMaintenance: null,
        shortingEnabled: snapshot.shortingBlocked === null,
        shortingBlockedReason: snapshot.shortingBlocked,
        unrealizedPnl,
        missingPrices,
        withdrawableCash: snapshot.withdrawable
    });
});
