"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import AnalysisDetailsView from "./AnalysisDetailsView";
import PositionLots from "./PositionLots";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { convertValue, describePlacedOrder, formatCurrency, formatPrice, formatShares, formatSigned, roundCents, toOrder, type TradeMode } from "@/lib/orders";
import { contractMultiplier, contractName, daysToExpiration, parseOptionSymbol } from "@/lib/options";
import type { AppOrder, BrokerOrderRequest, PortfolioPosition, PositionAnalysis, PositionVerdict } from "@/lib/types";

const VERDICT_LABELS: Record<PositionVerdict, string> = { HOLD: "Hold", SELL: "Sell", COVER: "Cover" };

// The result of the last trade, shown above the table
export interface Status {
    ok: boolean;
    message: string;
}

interface PortfolioRowProps {
    position: PortfolioPosition;
    // delta is the signed change in shares (negative for a sale)
    onTrade: (ticker: string, delta: number) => void;
    setStatus: (status: Status | null) => void;
    // False while the market is closed, when closing orders are queued for the open
    marketOpen?: boolean;
    // Called when a closing order is queued, to show it in the open orders
    onQueued?: () => void;
}

const PortfolioRow = ({ position, onTrade, setStatus, marketOpen = true, onQueued = () => {} }: PortfolioRowProps) => {
    const { ticker, quantity, avgCost, price, previousClose, bid, ask, error } = position;
    const isLong = quantity > 0;
    const shares = Math.abs(quantity);
    // An option position is in contracts of 100 shares: its values are × 100, and it closes in whole contracts
    const contract = parseOptionSymbol(ticker);
    const multiplier = contractMultiplier(ticker);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

    // tradeValue is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState<TradeMode>("shares");
    const [tradeValue, setTradeValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [loadingAnalysis, setLoadingAnalysis] = useState(false);
    const [showLots, setShowLots] = useState(false);
    const [exercising, setExercising] = useState(false);
    const { refreshAccount } = useAccount();

    const hasPrice = price !== null;
    // Longs close with a sell at the bid, shorts with a buy (cover) at the ask; the server sets the actual fill
    const tradePrice = hasPrice ? (isLong ? bid : ask) ?? price : null;
    const maxValue = mode === "dollars" ? roundCents(shares * (tradePrice ?? 0)) : shares;
    // A partial sell can leave the stepper above what's left of the position
    const stepperValue = Math.min(tradeValue, maxValue);
    const sized = toOrder({ mode, value: stepperValue, price: tradePrice, maxShares: shares });
    const closeQuantity = contract ? Math.floor(sized.quantity) : sized.quantity;
    const total = roundCents(sized.total * multiplier);
    // quantity is signed, so a short gains when the price falls
    const gain = hasPrice ? (price - avgCost) * quantity * multiplier : null;
    const dayChange = hasPrice && previousClose !== null ? (price - previousClose) * quantity * multiplier : null;
    const dayPercent = hasPrice && previousClose ? ((price - previousClose) / previousClose) * 100 * Math.sign(quantity) : null;
    const gainPercent = gain !== null && avgCost > 0 ? (gain / (shares * avgCost * multiplier)) * 100 : null;

    const onModeChange = (nextMode: TradeMode) => {
        if (nextMode === mode) return;
        // Keep a whole-position order whole, since converting could round it a fraction of a share short
        const nextMax = nextMode === "dollars" ? roundCents(shares * (tradePrice ?? 0)) : shares;
        setTradeValue(stepperValue >= maxValue ? nextMax : convertValue(nextMode, stepperValue, tradePrice));
        setMode(nextMode);
    };

    const onClosePosition = async () => {
        // Longs close with a sell, shorts with a buy (cover): a day market order with a closing position intent, which the broker caps
        // at the position when it fills, so it can't flip it (even if a buy-in has shrunk it since this page loaded)
        const side = isLong ? "sell" : "buy";
        const action = isLong ? "sell" : "cover";
        setSubmitting(true);
        setStatus(null);
        try {
            // A dollar amount that covers the whole position is sent as the whole position, so it closes it exactly
            const size = mode === "dollars" && stepperValue < maxValue ? { notional: stepperValue.toFixed(2) } : { qty: String(closeQuantity) };
            const request: BrokerOrderRequest = {
                symbol: ticker, side, type: "market", time_in_force: "day", ...size, position_intent: isLong ? "sell_to_close" : "buy_to_close",
                client_order_id: crypto.randomUUID()
            };
            const { data: order } = await axios.post<AppOrder>("/api/orders", request);
            setMode("shares");
            setTradeValue(1);
            const filled = Number(order.filled_qty ?? 0);
            if (order.status === "accepted") {
                setStatus({ ok: true, message: `The market is closed: ${action === "sell" ? "selling" : "covering"} ${size.qty ? `${formatShares(size.qty)} ${ticker}` : `${formatCurrency(size.notional!)} of ${ticker}`} is queued as a market order for the open.` });
                onQueued();
            } else if (order.status === "filled") {
                setStatus({ ok: true, message: `${isLong ? "Sold" : "Covered"} ${formatShares(filled)} ${contractName(ticker)} at ${formatPrice(order.filled_avg_price!)} (${formatCurrency(filled * Number(order.filled_avg_price) * multiplier)})` });
                onTrade(ticker, isLong ? -filled : filled);
            } else {
                const placed = describePlacedOrder(order);
                setStatus({ ok: placed.ok, message: order.reason && !placed.ok ? `${placed.message}: ${order.reason}` : placed.message });
                if (filled > 0) onTrade(ticker, isLong ? -filled : filled);
                onQueued();
            }
            refreshAccount();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't ${action} ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
        }
    };

    // Exercises every contract of a long option now: a call buys its shares at the strike, a put sells them
    const onExercise = async () => {
        if (!contract || !window.confirm(`Exercise ${formatShares(shares)} ${contractName(ticker)}? This ${contract.type === "call" ? "buys" : "sells"} ${formatShares(shares * multiplier)} shares of ${contract.underlying} at $${contract.strike}.`)) return;
        setExercising(true);
        setStatus(null);
        try {
            await axios.post(`/api/positions/${ticker}/exercise`, {});
            setStatus({ ok: true, message: `Exercised ${formatShares(shares)} ${contractName(ticker)}: ${contract.type === "call" ? "bought" : "sold"} ${formatShares(shares * multiplier)} ${contract.underlying} at $${contract.strike}` });
            onTrade(ticker, -quantity);
            refreshAccount();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't exercise ${contractName(ticker)}: ${apiErrorMessage(error)}` });
        } finally {
            setExercising(false);
        }
    };

    // The AI and news APIs are only called when the analysis is first opened
    const onAnalysisClick = async () => {
        const opening = !showAnalysis;
        setShowAnalysis(opening);
        if (!opening || analysis || loadingAnalysis) return;
        setLoadingAnalysis(true);
        setAnalysisError(null);
        try {
            const response = await axios.get<PositionAnalysis>(`/api/portfolio/${ticker}/analysis`);
            setAnalysis(response.data);
        } catch (error) {
            logError(error);
            setAnalysisError(apiErrorMessage(error));
        } finally {
            setLoadingAnalysis(false);
        }
    };

    return (
        <Fragment>
            <tr>
                <td>
                    <Link href={`/trading/${contract?.underlying ?? ticker}`} className="portfolio-ticker">{contract ? contractName(ticker) : ticker}</Link>
                    <span className={`position-side ${isLong ? "long" : "short"}`}>{isLong ? "LONG" : "SHORT"}</span>
                    {contract && <span className="option-dte" title={`Expires ${contract.expiration}`}>{daysToExpiration(contract.expiration, today)}d</span>}
                </td>
                <td>{formatShares(shares)}{contract ? <span className="fill-detail">contract{shares === 1 ? "" : "s"}</span> : null}</td>
                <td>{formatCurrency(avgCost)}</td>
                <td title={error ?? undefined}>{hasPrice ? formatCurrency(price) : "—"}</td>
                <td>{hasPrice ? formatCurrency(shares * price * multiplier) : "—"}</td>
                <td className={`price-change ${(dayChange ?? 0) >= 0 ? "positive" : "negative"}`}>
                    {dayChange !== null && dayPercent !== null ? `${formatSigned(dayChange)} (${dayPercent >= 0 ? "+" : ""}${dayPercent.toFixed(2)}%)` : "—"}
                </td>
                <td className={`price-change ${(gain ?? 0) >= 0 ? "positive" : "negative"}`}>
                    {gain !== null && gainPercent !== null ? `${formatSigned(gain)} (${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(2)}%)` : "—"}
                </td>
                <td>
                    <div className="portfolio-trade">
                        {!contract && <TradeModeToggle mode={mode} setMode={onModeChange} disabled={!hasPrice} />}
                        <div className="order-size">
                            <QuantityStepper value={stepperValue} setValue={setTradeValue} max={maxValue}
                                decimals={contract ? 0 : mode === "dollars" ? 2 : 6} prefix={mode === "dollars" ? "$" : ""} />
                            {mode === "dollars" && <span className="order-preview">≈ {formatShares(closeQuantity)} shares</span>}
                        </div>
                        <button className={isLong ? "sell-btn" : "buy-btn"} onClick={onClosePosition} disabled={submitting || !hasPrice || closeQuantity <= 0}
                            title={marketOpen ? undefined : "The market is closed: the order is queued for the open"}>
                            {marketOpen ? "" : "Queue "}{isLong ? (marketOpen ? "Sell" : "sell") : contract ? (marketOpen ? "Buy to close" : "buy to close") : (marketOpen ? "Cover" : "cover")} {hasPrice ? formatCurrency(total) : ""}
                        </button>
                        {contract && isLong && (
                            <button className="exercise-btn" onClick={onExercise} disabled={exercising} title="Exercise the contracts now (Alpaca also exercises in-the-money contracts at expiration)">
                                {exercising ? "Exercising..." : "Exercise"}
                            </button>
                        )}
                    </div>
                </td>
                <td>
                    <button className={`lots-btn ${showLots ? "open" : ""}`} onClick={() => setShowLots(!showLots)} title="Tax lots" aria-expanded={showLots}>Lots</button>
                    {!contract && <button className={`ai-btn ${showAnalysis ? "open" : ""}`} onClick={onAnalysisClick}
                        title={`AI ${isLong ? "hold/sell" : "hold/cover"} analysis`} aria-expanded={showAnalysis}>
                        {loadingAnalysis ? <span className="spinner-border spinner-border-sm" role="status" /> : "AI"}
                    </button>}
                </td>
            </tr>
            {showLots && (
                <tr className="portfolio-analysis-row">
                    <td colSpan={9}><PositionLots ticker={ticker} /></td>
                </tr>
            )}
            {showAnalysis && (
                <tr className="portfolio-analysis-row">
                    <td colSpan={9}>
                        <div className="analysis-box">
                            {analysisError ? <p className="text-danger">Couldn&apos;t load AI analysis: {analysisError}</p>
                                : analysis ? <AnalysisDetailsView verdictLabel={VERDICT_LABELS[analysis.verdict]} thesis={analysis.analysis} details={analysis} />
                                : <p>Loading...</p>}
                        </div>
                    </td>
                </tr>
            )}
        </Fragment>
    );
};

export default PortfolioRow;
