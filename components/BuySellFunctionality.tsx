"use client";

import { Fragment, useState, type MouseEvent } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatEastern, type MarketStatus } from "@/lib/marketHours";
import { convertValue, formatCurrency, formatPrice, formatShares, toOrder, type TradeMode } from "@/lib/orders";
import type { Quote, TradeRequest, TradeType, TransactionRow } from "@/lib/types";

interface Status {
    ok: boolean;
    message: string;
}

interface BuySellProps {
    ticker: string;
    quote: Quote;
    market: MarketStatus | null;
    // Called after a trade, to refresh the quote
    onTraded?: () => void;
}

// Market orders: buys fill at the ask and sells at the bid (or the last price without bid/ask). The server sets the actual fill,
// from its own quote, so the totals here are estimates.
const BuySellFunctionality = ({ ticker, quote, market, onTraded = () => {} }: BuySellProps) => {
    // value is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState<TradeMode>("shares");
    const [value, setValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const { account, refreshAccount } = useAccount();
    const buyPrice = quote.ask ?? quote.price;
    const sellPrice = quote.bid ?? quote.price;
    const buyOrder = toOrder({ mode, value, price: buyPrice });
    const sellOrder = toOrder({ mode, value, price: sellPrice });
    // Covering a short and selling a long are always allowed (the server judges trades that go past zero). Otherwise a buy needs its
    // cost available, a new short needs 50% of its value (150% is held as collateral and its proceeds cover 100%), and during a
    // margin call neither is allowed.
    const held = account?.positions.find(position => position.ticker === ticker.toUpperCase())?.quantity ?? 0;
    const marginCall = (account?.collateralShortfall ?? 0) > 0;
    const shortCollateral = sellOrder.total / 2;
    const buyBlocked = account !== null && held >= 0 && (marginCall || buyOrder.total > account.availableCash);
    const sellBlocked = account !== null && held <= 0 && (marginCall || shortCollateral > account.availableCash);
    const closed = market !== null && !market.open;

    const onModeChange = (nextMode: TradeMode) => {
        if (nextMode === mode) return;
        setValue(convertValue(nextMode, value, quote.price));
        setMode(nextMode);
    };

    const onSubmitForm = async (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        const type: TradeType = e.currentTarget.id === "buyButton" ? "BUY" : "SELL";
        setSubmitting(true);
        setStatus(null);
        try {
            const order: TradeRequest["order"] = mode === "dollars" ? { type, amount: value } : { type, quantity: value };
            const { data: fill } = await axios.post<TransactionRow>(`/api/trading/${ticker}`, { order } satisfies TradeRequest);
            setStatus({ ok: true, message: `${type === "BUY" ? "Bought" : "Sold"} ${formatShares(fill.quantity)} ${ticker} at ${formatPrice(fill.price)} (${formatCurrency(fill.total)})` });
            refreshAccount();
            onTraded();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't ${type.toLowerCase()} ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Fragment>
            <div className="container">
                <TradeModeToggle mode={mode} setMode={onModeChange} />
                <QuantityStepper value={value} setValue={setValue} decimals={mode === "dollars" ? 2 : 6} prefix={mode === "dollars" ? "$" : ""} />
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm} disabled={submitting || closed || buyOrder.quantity <= 0 || buyBlocked}>Buy {formatCurrency(buyOrder.total)}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm} disabled={submitting || closed || sellOrder.quantity <= 0 || sellBlocked}>Sell {formatCurrency(sellOrder.total)}</button>
            </div>
            <p className="order-preview">
                {mode === "dollars"
                    ? `≈ ${formatShares(buyOrder.quantity)} shares at the ask (${formatPrice(buyPrice)}), or ${formatShares(sellOrder.quantity)} at the bid (${formatPrice(sellPrice)})`
                    : quote.spread === "none"
                        ? `Market order at the last price, ${formatPrice(quote.price)}`
                        : `Market order: buys fill at the ask (${formatPrice(buyPrice)}), sells at the bid (${formatPrice(sellPrice)})`}
            </p>
            {closed && market ? (
                <p className="text-danger">The market is closed. Orders can be placed when it opens, {formatEastern(market.nextOpen, { withDay: true })}.</p>
            ) : marginCall && (buyBlocked || sellBlocked) ? (
                <p className="text-danger">Margin call: only covers and sales of long positions are allowed until the collateral shortfall is fixed. <Link href="/deposit">Deposit</Link></p>
            ) : (
                <Fragment>
                    {buyBlocked && <p className="text-danger">Insufficient funds to buy. <Link href="/deposit">Deposit</Link></p>}
                    {sellBlocked && (
                        <p className="text-danger">
                            Insufficient collateral to short: needs {formatCurrency(shortCollateral)} available (150% of a short is held as collateral; its proceeds cover 100%).{" "}
                            <Link href="/deposit">Deposit</Link>
                        </p>
                    )}
                </Fragment>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </Fragment>
    )
};

export default BuySellFunctionality;
