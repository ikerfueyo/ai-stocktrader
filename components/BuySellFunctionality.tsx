"use client";

import { Fragment, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatEastern, type MarketStatus } from "@/lib/marketHours";
import { feesFor, roundFeeUp } from "@/lib/server/broker/sim/feeSchedule";
import { convertValue, describePlacedOrder, formatCurrency, formatPrice, formatShares, ORDER_TYPE_LABELS, TIME_IN_FORCE_LABELS, toOrder, type TradeMode } from "@/lib/orders";
import type { AppOrder, BrokerAsset, BrokerOrderRequest, ListLocateQuotesResponse, Locate, Quote } from "@/lib/types";

type OrderType = BrokerOrderRequest["type"];
type TimeInForce = BrokerOrderRequest["time_in_force"];
type Side = "buy" | "sell";
// The exits an order carries: none, a bracket (take profit and stop loss), an OTO's one exit, or an OCO that exits a position
type Exits = "none" | "bracket" | "take_profit" | "stop_loss" | "oco";

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

const ORDER_TYPES = Object.keys(ORDER_TYPE_LABELS) as OrderType[];

// The times in force each order allows, as the broker checks them: auctions (OPG, CLS) and IOC/FOK for market and limit orders,
// day or GTC for stops and anything with exits, day only for dollar-amount and fractional orders
const timesInForce = (type: OrderType, exits: Exits, fractional: boolean): TimeInForce[] => {
    if (fractional) return ["day"];
    if (exits !== "none" || type === "stop" || type === "stop_limit" || type === "trailing_stop") return ["day", "gtc"];
    return ["day", "gtc", "opg", "cls", "ioc", "fok"];
};

const today = () => new Date().toISOString().slice(0, 10);

// Order entry, in the broker's terms (Alpaca's order request): market, limit, stop, stop-limit and trailing-stop orders; good for the
// day, until cancelled, at the open or close auction, immediate-or-cancel or fill-or-kill; limit orders in extended hours; shares or
// (market and limit day orders) a dollar amount; and exits attached: a bracket's take profit and stop loss, or one of them (OTO), or
// an OCO that exits the position. The broker sets every fill and checks every rule, so the figures here are estimates.
const BuySellFunctionality = ({ ticker, quote, market, onTraded = () => {} }: BuySellProps) => {
    const decimals = quote.price < 1 ? 4 : 2;
    const round = (price: number) => Number(price.toFixed(decimals));
    const [orderType, setOrderType] = useState<OrderType>("market");
    const [timeInForce, setTimeInForce] = useState<TimeInForce>("day");
    const [extendedHours, setExtendedHours] = useState(false);
    const [mode, setMode] = useState<TradeMode>("shares");
    const [value, setValue] = useState(1);
    const [limitPrice, setLimitPrice] = useState(() => round(quote.price));
    const [stopPrice, setStopPrice] = useState(() => round(quote.price));
    const [trailKind, setTrailKind] = useState<"percent" | "price">("percent");
    const [trail, setTrail] = useState(5);
    const [exits, setExits] = useState<Exits>("none");
    const [takeProfit, setTakeProfit] = useState(() => round(quote.price * 1.1));
    const [stopLoss, setStopLoss] = useState(() => round(quote.price * 0.95));
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const { account, refreshAccount } = useAccount();
    // The stock's margin and borrow flags (marginable, shortable, easy or hard to borrow), and the shares located to short it today
    const [asset, setAsset] = useState<BrokerAsset | null>(null);
    const [locates, setLocates] = useState<Locate[]>([]);
    const [locateQuote, setLocateQuote] = useState<{ price: number | null; available: number } | null>(null);
    const [locating, setLocating] = useState(false);
    const [locatesVersion, setLocatesVersion] = useState(0);
    const hardToBorrow = asset?.borrow_status === "hard_to_borrow";

    useEffect(() => {
        axios.get<BrokerAsset>(`/api/assets/${encodeURIComponent(ticker)}`).then(({ data }) => setAsset(data)).catch(logError);
    }, [ticker]);

    useEffect(() => {
        if (!hardToBorrow) return;
        axios.get<{ locates: Locate[] }>(`/api/locates?symbol=${encodeURIComponent(ticker)}&status=active`).then(({ data }) => setLocates(data.locates)).catch(logError);
        axios.get<ListLocateQuotesResponse>(`/api/locates/quotes?symbols=${encodeURIComponent(ticker)}`)
            .then(({ data }) => {
                const found = data.quotes.find(({ symbol }) => symbol === ticker.toUpperCase());
                setLocateQuote(found ? { price: found.price ? Number(found.price) : null, available: found.available_qty } : null);
            })
            .catch(logError);
    }, [ticker, hardToBorrow, locatesVersion]);

    const held = account?.positions.find(position => position.ticker === ticker.toUpperCase())?.quantity ?? 0;
    const usesLimit = orderType === "limit" || orderType === "stop_limit";
    const usesStop = orderType === "stop" || orderType === "stop_limit";
    const isTrailing = orderType === "trailing_stop";
    const dollarsAllowed = (orderType === "market" || orderType === "limit") && exits === "none" && !extendedHours;
    const orderMode = dollarsAllowed ? mode : "shares";
    const fractional = orderMode === "dollars" || !Number.isInteger(value);
    const tifOptions = timesInForce(orderType, exits, fractional);
    const tif = tifOptions.includes(timeInForce) ? timeInForce : tifOptions[0];
    const extendedAllowed = orderType === "limit" && (tif === "day" || tif === "gtc") && exits === "none";
    const extended = extendedAllowed && extendedHours;

    // The price each side is estimated at: the ask or bid for market orders, the limit, the stop, or where a trailing stop would
    // trigger now
    const trailOffset = trailKind === "percent" ? quote.price * trail / 100 : trail;
    const estimate = (side: Side) => {
        if (usesLimit) return limitPrice;
        if (usesStop) return stopPrice;
        if (isTrailing) return round(side === "sell" ? quote.price - trailOffset : quote.price + trailOffset);
        return side === "buy" ? quote.ask ?? quote.price : quote.bid ?? quote.price;
    };
    const buyOrder = toOrder({ mode: orderMode, value, price: estimate("buy") });
    const sellOrder = toOrder({ mode: orderMode, value, price: estimate("sell") });
    // An OCO exits the position, so only its closing side applies
    const closingSide: Side | null = held > 0 ? "sell" : held < 0 ? "buy" : null;
    const ocoBlocked = (side: Side) => exits === "oco" && side !== closingSide;
    // Covers and sales of longs never need buying power, but an order can't go past the position (close it first to flip). Otherwise
    // an order uses its value of buying power (twice that for a non-marginable stock on margin), a short needs an account and a stock
    // that allow it (and a locate when it's hard to borrow), and during a margin call nothing new is allowed.
    const marginCall = (account?.marginCalls.length ?? 0) > 0;
    const buyingPower = account?.buyingPower ?? 0;
    const bpCost = (total: number) => asset?.marginable === false && (account?.multiplier ?? 1) > 1 ? total * account!.multiplier : total;
    const located = locates.reduce((sum, locate) => sum + (locate.located_qty ?? 0), 0);
    const shortProblem = !account ? null : !account.shortingEnabled ? account.shortingBlockedReason
        : asset?.shortable === false ? `${ticker} can't be sold short` : null;
    const pastPosition = (side: Side, shares: number) => side === "sell" ? held > 0 && shares > held + 1e-9 : held < 0 && shares > -held + 1e-9;
    const buyBlocked = account !== null && (held < 0 ? pastPosition("buy", buyOrder.quantity) : marginCall || bpCost(buyOrder.total) > buyingPower);
    const sellBlocked = account !== null && (held > 0 ? pastPosition("sell", sellOrder.quantity) : shortProblem !== null || marginCall || bpCost(sellOrder.total) > buyingPower);
    const needsLocate = held <= 0 && hardToBorrow && shortProblem === null;
    const locateShares = Math.max(100, Math.ceil(sellOrder.quantity / 100) * 100);

    const onLocate = async () => {
        setLocating(true);
        setStatus(null);
        try {
            const { data } = await axios.post<Locate>("/api/locates", { symbol: ticker.toUpperCase(), qty: locateShares });
            setStatus(data.status === "active"
                ? { ok: true, message: `Located ${data.located_qty} ${ticker} for ${formatCurrency(data.total_fee!)} (until ${formatEastern(data.expires_at!)})` }
                : { ok: false, message: `The locate was rejected (${data.rejection_reason?.replaceAll("_", " ")})` });
            refreshAccount();
            setLocatesVersion(version => version + 1);
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't locate ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setLocating(false);
        }
    };
    const pricesValid = (!usesLimit || limitPrice > 0) && (!usesStop || stopPrice > 0) && (!isTrailing || (trail > 0 && (trailKind === "price" || trail < 100)))
        && (exits === "none" || exits === "stop_loss" || takeProfit > 0) && (exits === "none" || exits === "take_profit" || stopLoss > 0);
    const closed = market !== null && !market.open;
    const fees = (side: Side) => {
        const { quantity } = side === "buy" ? buyOrder : sellOrder;
        const byType = new Map<string, number>();
        for (const { type, amount } of feesFor({ side, qty: quantity, price: estimate(side), date: today() })) byType.set(type, (byType.get(type) ?? 0) + amount);
        return [...byType.values()].reduce((sum, amount) => sum + roundFeeUp(amount), 0);
    };

    const onModeChange = (nextMode: TradeMode) => {
        if (nextMode === mode) return;
        setValue(convertValue(nextMode, value, quote.price));
        setMode(nextMode);
    };

    const onExitsChange = (next: Exits) => {
        setExits(next);
        // An OCO is a limit order (its limit is the take profit); a bracket's entry is a market or limit order
        if (next === "oco") setOrderType("limit");
        else if (next !== "none" && orderType !== "market" && orderType !== "limit") setOrderType("market");
        if (next !== "none" && !Number.isInteger(value)) setValue(Math.max(1, Math.floor(value)));
        if (next === "oco" && closingSide) {
            setTakeProfit(round(quote.price * (closingSide === "sell" ? 1.1 : 0.9)));
            setStopLoss(round(quote.price * (closingSide === "sell" ? 0.95 : 1.05)));
        }
    };

    const request = (side: Side): BrokerOrderRequest => {
        const { quantity } = side === "buy" ? buyOrder : sellOrder;
        const size = orderMode === "dollars" ? { notional: value.toFixed(2) } : { qty: String(quantity) };
        // The exits are on the other side of the entry (an OCO's on the side it closes), which the broker works out
        const legs = exits === "none" ? {} : {
            order_class: exits === "bracket" ? "bracket" : exits === "oco" ? "oco" : "oto",
            ...(exits !== "stop_loss" ? { take_profit: { limit_price: String(takeProfit) } } : {}),
            ...(exits !== "take_profit" ? { stop_loss: { stop_price: String(stopLoss) } } : {})
        } as const;
        return {
            symbol: ticker.toUpperCase(), side, type: orderType, time_in_force: tif, ...size,
            ...(usesLimit && exits !== "oco" ? { limit_price: String(limitPrice) } : {}),
            ...(exits === "oco" ? { limit_price: String(takeProfit) } : {}),
            ...(usesStop ? { stop_price: String(stopPrice) } : {}),
            ...(isTrailing ? (trailKind === "percent" ? { trail_percent: String(trail) } : { trail_price: String(trail) }) : {}),
            ...(extended ? { extended_hours: true } : {}),
            ...legs,
            // A fresh ID per submission, so the broker refuses a duplicate of the same order
            client_order_id: crypto.randomUUID()
        };
    };

    const onSubmitForm = async (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        const side: Side = e.currentTarget.id === "buyButton" ? "buy" : "sell";
        setSubmitting(true);
        setStatus(null);
        try {
            const { data: order } = await axios.post<AppOrder>("/api/orders", request(side));
            const placed = describePlacedOrder(order, { nextOpen: market?.nextOpen });
            setStatus({ ok: placed.ok, message: order.reason && !placed.ok ? `${placed.message}: ${order.reason}` : placed.message });
            refreshAccount();
            onTraded();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't place the ${side} order for ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
        }
    };

    const queued = closed && !extended && tif !== "cls";
    const verb = (side: string) => queued ? `Queue ${side.toLowerCase()}` : side;
    const sizeStep = exits !== "none" ? 0 : orderMode === "dollars" ? 2 : 6;

    return (
        <Fragment>
            <div className="order-entry">
                <label>
                    Order
                    <select className="form-control form-control-sm" value={orderType} onChange={e => setOrderType(e.target.value as OrderType)} disabled={exits === "oco"}>
                        {ORDER_TYPES.filter(type => exits === "none" || type === "market" || type === "limit").map(type => <option key={type} value={type}>{ORDER_TYPE_LABELS[type]}</option>)}
                    </select>
                </label>
                <label>
                    Good for
                    <select className="form-control form-control-sm" value={tif} onChange={e => setTimeInForce(e.target.value as TimeInForce)}>
                        {tifOptions.map(option => <option key={option} value={option}>{TIME_IN_FORCE_LABELS[option]}</option>)}
                    </select>
                </label>
                <label>
                    Exits
                    <select className="form-control form-control-sm" value={exits} onChange={e => onExitsChange(e.target.value as Exits)}>
                        <option value="none">None</option>
                        <option value="bracket">Take profit + stop loss</option>
                        <option value="take_profit">Take profit</option>
                        <option value="stop_loss">Stop loss</option>
                        {closingSide && <option value="oco">Exit position (OCO)</option>}
                    </select>
                </label>
                {extendedAllowed && (
                    <label title="Limit orders can also trade in the pre-market (from 4:00 a.m. ET) and after hours (to 8:00 p.m.)">
                        <input type="checkbox" checked={extendedHours} onChange={e => setExtendedHours(e.target.checked)} /> Extended hours
                    </label>
                )}
            </div>
            {(usesLimit || usesStop || isTrailing || exits !== "none") && (
                <div className="order-entry">
                    {usesStop && <label>Stop <QuantityStepper value={stopPrice} setValue={setStopPrice} decimals={decimals} prefix="$" /></label>}
                    {usesLimit && exits !== "oco" && <label>Limit <QuantityStepper value={limitPrice} setValue={setLimitPrice} decimals={decimals} prefix="$" /></label>}
                    {isTrailing && (
                        <label>
                            Trail
                            <QuantityStepper value={trail} setValue={setTrail} decimals={2} prefix={trailKind === "price" ? "$" : ""} />
                            <select className="form-control form-control-sm" value={trailKind} onChange={e => setTrailKind(e.target.value as "percent" | "price")}>
                                <option value="percent">%</option>
                                <option value="price">$</option>
                            </select>
                        </label>
                    )}
                    {(exits === "bracket" || exits === "take_profit" || exits === "oco") && <label>Take profit <QuantityStepper value={takeProfit} setValue={setTakeProfit} decimals={decimals} prefix="$" /></label>}
                    {(exits === "bracket" || exits === "stop_loss" || exits === "oco") && <label>Stop loss <QuantityStepper value={stopLoss} setValue={setStopLoss} decimals={decimals} prefix="$" /></label>}
                </div>
            )}
            <div className="container">
                <TradeModeToggle mode={orderMode} setMode={onModeChange} disabled={!dollarsAllowed} />
                <QuantityStepper value={value} setValue={setValue} decimals={sizeStep} prefix={orderMode === "dollars" ? "$" : ""} />
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm}
                    disabled={submitting || !pricesValid || buyOrder.quantity <= 0 || buyBlocked || ocoBlocked("buy")}>{verb("Buy")} {formatCurrency(buyOrder.total)}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm}
                    disabled={submitting || !pricesValid || sellOrder.quantity <= 0 || sellBlocked || ocoBlocked("sell")}>{verb("Sell")} {formatCurrency(sellOrder.total)}</button>
            </div>
            <p className="order-preview">
                {orderType === "limit" && exits !== "oco"
                    ? `Fills only at ${formatPrice(limitPrice)} or better: buys when the ask is at or below it, sells when the bid is at or above it.`
                    : orderType === "stop"
                        ? `When the price reaches ${formatPrice(stopPrice)} (a buy at or above it, a sell at or below it), it becomes a market order.`
                        : orderType === "stop_limit"
                            ? `When the price reaches ${formatPrice(stopPrice)}, it becomes a limit order at ${formatPrice(limitPrice)}.`
                            : isTrailing
                                ? `The stop follows the price ${trailKind === "percent" ? `${trail}%` : formatPrice(trail)} behind its best level and becomes a market order when reached (now ${formatPrice(estimate("sell"))} for a sell, ${formatPrice(estimate("buy"))} for a buy).`
                                : exits === "oco"
                                    ? `Closes the position at ${formatPrice(takeProfit)} or better, or as a stop at ${formatPrice(stopLoss)}, whichever comes first; one cancels the other.`
                                    : orderMode === "dollars"
                                        ? `≈ ${formatShares(buyOrder.quantity)} shares at the ask (${formatPrice(estimate("buy"))}), or ${formatShares(sellOrder.quantity)} at the bid (${formatPrice(estimate("sell"))})`
                                        : quote.spread === "none"
                                            ? `Market order at the last price, ${formatPrice(quote.price)}`
                                            : `Market order: buys fill at the ask (${formatPrice(estimate("buy"))}), sells at the bid (${formatPrice(estimate("sell"))})`}
                {(exits === "bracket" || exits === "take_profit" || exits === "stop_loss") && ` Once it fills, ${exits === "bracket" ? `a take profit at ${formatPrice(takeProfit)} and a stop loss at ${formatPrice(stopLoss)} (one cancels the other) close it` : exits === "take_profit" ? `a take profit at ${formatPrice(takeProfit)} closes it` : `a stop loss at ${formatPrice(stopLoss)} closes it`}.`}
            </p>
            <p className="order-preview">
                Buying power {formatCurrency(buyingPower)}{asset?.marginable === false ? " (not marginable: 100% initial margin)" : ""} · Commission $0.00 · Est. regulatory fees {formatCurrency(fees("buy"))} on the buy, {formatCurrency(fees("sell"))} on the sell
            </p>
            {closed && market && (
                <p className="text-muted">
                    {extended
                        ? market.extendedOpen ? "Extended hours are open: this limit order can trade now." : `The market is closed until ${formatEastern(market.nextOpen, { withDay: true })}; extended-hours trading starts at 4:00 a.m. ET.`
                        : `The market is closed until ${formatEastern(market.nextOpen, { withDay: true })}. Orders are accepted now and work from the open${tif === "cls" ? " (at the close for this one)" : ""}.`}
                </p>
            )}
            {marginCall && (buyBlocked || sellBlocked) ? (
                <p className="text-danger">Margin call: only closing orders are allowed until it&apos;s met. <Link href="/deposit">Deposit</Link></p>
            ) : (
                <Fragment>
                    {held < 0 && pastPosition("buy", buyOrder.quantity) && <p className="text-danger">You&apos;re short {formatShares(-held)} {ticker}: an order can&apos;t buy past the position. Cover it first, then buy.</p>}
                    {held > 0 && pastPosition("sell", sellOrder.quantity) && <p className="text-danger">You hold {formatShares(held)} {ticker}: an order can&apos;t sell past the position. Sell it first, then short.</p>}
                    {held >= 0 && buyBlocked && <p className="text-danger">Insufficient buying power: this order needs {formatCurrency(bpCost(buyOrder.total))}. <Link href="/deposit">Deposit</Link></p>}
                    {held <= 0 && shortProblem && <p className="text-muted">Shorting: {shortProblem}{account?.shortingEnabled === false ? " (Settings)" : ""}.</p>}
                    {held <= 0 && !shortProblem && sellBlocked && <p className="text-danger">Insufficient buying power to short: this order needs {formatCurrency(bpCost(sellOrder.total))}. <Link href="/deposit">Deposit</Link></p>}
                    {needsLocate && (
                        <p className={located >= sellOrder.quantity ? "text-muted" : "text-warning"}>
                            {ticker} is hard to borrow: a short sale needs a locate first, and holding the short costs a daily borrow fee. {located > 0 ? `${located} shares located today. ` : ""}
                            {locateQuote && (locateQuote.available > 0 && locateQuote.price !== null
                                ? <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onLocate} disabled={locating}>
                                    {locating ? "Locating…" : `Locate ${locateShares} for ${formatCurrency(locateShares * locateQuote.price)}`}
                                </button>
                                : "No shares are available to locate today.")}
                        </p>
                    )}
                </Fragment>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </Fragment>
    );
};

export default BuySellFunctionality;
