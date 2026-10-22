"use client";

import { Fragment, useState, type MouseEvent } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatEastern, type MarketStatus } from "@/lib/marketHours";
import { convertValue, describeOrderType, formatCurrency, formatPrice, formatShares, roundCents, toOrder, type TradeMode } from "@/lib/orders";
import type { OrderRequest, OrderRow, OrderType, Quote, TimeInForce, TradeRequest, TradeResponse, TradeType } from "@/lib/types";

interface Status {
    ok: boolean;
    message: string;
}

interface BuySellProps {
    ticker: string;
    quote: Quote;
    market: MarketStatus | null;
    // Called after an order is placed, to refresh the quote and the open orders
    onTraded?: () => void;
}

const ORDER_TYPES: { value: OrderType; label: string }[] = [
    { value: "MARKET", label: "Market" }, { value: "LIMIT", label: "Limit" }, { value: "STOP", label: "Stop" }, { value: "STOP_LIMIT", label: "Stop limit" }
];

// Order entry. Market orders fill now (buys at the ask, sells at the bid, or the last price without bid/ask), or are queued for the
// open while the market is closed; they can be for shares or a dollar amount. Limit, stop and stop-limit orders are for shares,
// good for the day or until cancelled, and fill on the server when the price reaches them. The server sets every fill, so the
// totals here are estimates.
const BuySellFunctionality = ({ ticker, quote, market, onTraded = () => {} }: BuySellProps) => {
    // value is a number of shares, or a dollar amount in "dollars" mode (market orders only)
    const [orderType, setOrderType] = useState<OrderType>("MARKET");
    const [mode, setMode] = useState<TradeMode>("shares");
    const [value, setValue] = useState(1);
    const [limitPrice, setLimitPrice] = useState(() => roundCents(quote.price));
    const [stopPrice, setStopPrice] = useState(() => roundCents(quote.price));
    const [timeInForce, setTimeInForce] = useState<TimeInForce>("DAY");
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const { account, refreshAccount } = useAccount();
    const isMarket = orderType === "MARKET";
    const usesLimit = orderType === "LIMIT" || orderType === "STOP_LIMIT";
    const usesStop = orderType === "STOP" || orderType === "STOP_LIMIT";
    const orderMode = isMarket ? mode : "shares";
    // The price each side is estimated at: the ask or bid for market orders, else the limit (or the stop for a stop order)
    const conditionalPrice = usesLimit ? limitPrice : stopPrice;
    const buyPrice = isMarket ? quote.ask ?? quote.price : conditionalPrice;
    const sellPrice = isMarket ? quote.bid ?? quote.price : conditionalPrice;
    const buyOrder = toOrder({ mode: orderMode, value, price: buyPrice });
    const sellOrder = toOrder({ mode: orderMode, value, price: sellPrice });
    // Covering a short and selling a long are always allowed (the server judges trades that go past zero). Otherwise a buy needs its
    // cost available, a new short needs 50% of its value (150% is held as collateral and its proceeds cover 100%), and during a
    // margin call neither is allowed. Available cash already excludes what open orders reserve.
    const held = account?.positions.find(position => position.ticker === ticker.toUpperCase())?.quantity ?? 0;
    const marginCall = (account?.collateralShortfall ?? 0) > 0;
    const shortCollateral = sellOrder.total / 2;
    const buyBlocked = account !== null && held >= 0 && (marginCall || buyOrder.total > account.availableCash);
    const sellBlocked = account !== null && held <= 0 && (marginCall || shortCollateral > account.availableCash);
    const closed = market !== null && !market.open;
    const pricesValid = (!usesLimit || limitPrice > 0) && (!usesStop || stopPrice > 0);

    const onModeChange = (nextMode: TradeMode) => {
        if (nextMode === mode) return;
        setValue(convertValue(nextMode, value, quote.price));
        setMode(nextMode);
    };

    const onOrderTypeChange = (nextType: OrderType) => {
        // Conditional orders are for shares
        if (nextType !== "MARKET" && mode === "dollars") {
            setValue(convertValue("shares", value, quote.price));
            setMode("shares");
        }
        setOrderType(nextType);
    };

    const placedMessage = (order: OrderRow) => {
        const what = `${order.side === "BUY" ? "Buy" : "Sell"} ${order.quantity !== null ? formatShares(order.quantity) : formatCurrency(order.amount!)} ${ticker}`;
        if (order.status === "FILLED") return `${what} (${describeOrderType(order)}) filled right away.`;
        if (order.status === "REJECTED") return `${what} was rejected: ${order.status_reason}`;
        if (order.order_type === "MARKET") return `The market is closed: ${what} is queued as a market order for the open${market ? `, ${formatEastern(market.nextOpen, { withDay: true })}` : ""}.`;
        return `Placed: ${what}, ${describeOrderType(order).toLowerCase()}, ${order.time_in_force === "GTC" ? "good until cancelled" : "good for the day"}.`;
    };

    const onSubmitForm = async (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        const type: TradeType = e.currentTarget.id === "buyButton" ? "BUY" : "SELL";
        setSubmitting(true);
        setStatus(null);
        try {
            if (isMarket) {
                const order: TradeRequest["order"] = mode === "dollars" ? { type, amount: value } : { type, quantity: value };
                const { data } = await axios.post<TradeResponse>(`/api/trading/${ticker}`, { order } satisfies TradeRequest);
                if (data.fill) {
                    const { fill } = data;
                    setStatus({ ok: true, message: `${type === "BUY" ? "Bought" : "Sold"} ${formatShares(fill.quantity)} ${ticker} at ${formatPrice(fill.price)} (${formatCurrency(fill.total)})` });
                } else {
                    setStatus({ ok: true, message: placedMessage(data.order) });
                }
            } else {
                const request: OrderRequest = {
                    order: {
                        ticker, side: type, orderType, quantity: value, timeInForce,
                        ...(usesLimit && { limitPrice }), ...(usesStop && { stopPrice })
                    }
                };
                const { data: { order } } = await axios.post<{ order: OrderRow }>("/api/orders", request);
                setStatus({ ok: order.status !== "REJECTED", message: placedMessage(order) });
            }
            refreshAccount();
            onTraded();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't place the ${type.toLowerCase()} order for ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
        }
    };

    const verb = (side: string) => isMarket && closed ? `Queue ${side.toLowerCase()}` : side;

    return (
        <Fragment>
            <div className="order-entry">
                <label>
                    Order
                    <select className="form-control form-control-sm" value={orderType} onChange={e => onOrderTypeChange(e.target.value as OrderType)}>
                        {ORDER_TYPES.map(({ value: type, label }) => <option key={type} value={type}>{label}</option>)}
                    </select>
                </label>
                {!isMarket && (
                    <label>
                        Good for
                        <select className="form-control form-control-sm" value={timeInForce} onChange={e => setTimeInForce(e.target.value as TimeInForce)}>
                            <option value="DAY">Day</option>
                            <option value="GTC">Until cancelled</option>
                        </select>
                    </label>
                )}
            </div>
            {!isMarket && (
                <div className="order-entry">
                    {usesStop && <label>Stop <QuantityStepper value={stopPrice} setValue={setStopPrice} decimals={2} prefix="$" /></label>}
                    {usesLimit && <label>Limit <QuantityStepper value={limitPrice} setValue={setLimitPrice} decimals={2} prefix="$" /></label>}
                </div>
            )}
            <div className="container">
                <TradeModeToggle mode={orderMode} setMode={onModeChange} disabled={!isMarket} />
                <QuantityStepper value={value} setValue={setValue} decimals={orderMode === "dollars" ? 2 : 6} prefix={orderMode === "dollars" ? "$" : ""} />
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm} disabled={submitting || !pricesValid || buyOrder.quantity <= 0 || buyBlocked}>{verb("Buy")} {formatCurrency(buyOrder.total)}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm} disabled={submitting || !pricesValid || sellOrder.quantity <= 0 || sellBlocked}>{verb("Sell")} {formatCurrency(sellOrder.total)}</button>
            </div>
            <p className="order-preview">
                {!isMarket
                    ? orderType === "LIMIT"
                        ? `Fills only at ${formatPrice(limitPrice)} or better: buys when the ask is at or below it, sells when the bid is at or above it.`
                        : orderType === "STOP"
                            ? `When the price reaches ${formatPrice(stopPrice)} (a buy at or above it, a sell at or below it), it becomes a market order.`
                            : `When the price reaches ${formatPrice(stopPrice)}, it becomes a limit order at ${formatPrice(limitPrice)}.`
                    : mode === "dollars"
                        ? `≈ ${formatShares(buyOrder.quantity)} shares at the ask (${formatPrice(buyPrice)}), or ${formatShares(sellOrder.quantity)} at the bid (${formatPrice(sellPrice)})`
                        : quote.spread === "none"
                            ? `Market order at the last price, ${formatPrice(quote.price)}`
                            : `Market order: buys fill at the ask (${formatPrice(buyPrice)}), sells at the bid (${formatPrice(sellPrice)})`}
            </p>
            {closed && market && (
                <p className="text-muted">
                    The market is closed until {formatEastern(market.nextOpen, { withDay: true })}. {isMarket ? "Market orders are queued for the open." : "Orders can only fill while it's open."}
                </p>
            )}
            {marginCall && (buyBlocked || sellBlocked) ? (
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
