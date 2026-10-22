"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import AnalysisDetailsView from "./AnalysisDetailsView";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { convertValue, formatCurrency, formatPrice, formatShares, formatSigned, roundCents, toOrder, type TradeMode } from "@/lib/orders";
import type { PortfolioPosition, PositionAnalysis, PositionVerdict, TradeRequest, TradeResponse } from "@/lib/types";

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

    // tradeValue is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState<TradeMode>("shares");
    const [tradeValue, setTradeValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [loadingAnalysis, setLoadingAnalysis] = useState(false);
    const { refreshAccount } = useAccount();

    const hasPrice = price !== null;
    // Longs close with a sell at the bid, shorts with a buy (cover) at the ask; the server sets the actual fill
    const tradePrice = hasPrice ? (isLong ? bid : ask) ?? price : null;
    const maxValue = mode === "dollars" ? roundCents(shares * (tradePrice ?? 0)) : shares;
    // A partial sell can leave the stepper above what's left of the position
    const stepperValue = Math.min(tradeValue, maxValue);
    const { quantity: closeQuantity, total } = toOrder({ mode, value: stepperValue, price: tradePrice, maxShares: shares });
    // quantity is signed, so a short gains when the price falls
    const gain = hasPrice ? (price - avgCost) * quantity : null;
    const dayChange = hasPrice && previousClose !== null ? (price - previousClose) * quantity : null;
    const dayPercent = hasPrice && previousClose ? ((price - previousClose) / previousClose) * 100 * Math.sign(quantity) : null;
    const gainPercent = gain !== null ? (gain / (shares * avgCost)) * 100 : null;

    const onModeChange = (nextMode: TradeMode) => {
        if (nextMode === mode) return;
        // Keep a whole-position order whole, since converting could round it a fraction of a share short
        const nextMax = nextMode === "dollars" ? roundCents(shares * (tradePrice ?? 0)) : shares;
        setTradeValue(stepperValue >= maxValue ? nextMax : convertValue(nextMode, stepperValue, tradePrice));
        setMode(nextMode);
    };

    const onClosePosition = async () => {
        // Longs close with a sell, shorts with a buy (cover)
        const type = isLong ? "SELL" : "BUY";
        const action = isLong ? "sell" : "cover";
        setSubmitting(true);
        setStatus(null);
        try {
            // A dollar amount that covers the whole position closes it exactly on the server, at whatever the fill price is
            const order: TradeRequest["order"] = mode === "dollars" && stepperValue < maxValue
                ? { type, amount: stepperValue }
                : { type, quantity: closeQuantity };
            // close: the server refuses (rather than flipping the position) if a buy-in has shrunk it since this page loaded
            const { data } = await axios.post<TradeResponse>(`/api/trading/${ticker}`, { order, close: true } satisfies TradeRequest);
            setMode("shares");
            setTradeValue(1);
            if (data.order) {
                const size = data.order.quantity !== null ? `${formatShares(data.order.quantity)} ${ticker}` : `${formatCurrency(data.order.amount!)} of ${ticker}`;
                setStatus({ ok: true, message: `The market is closed: ${action === "sell" ? "selling" : "covering"} ${size} is queued as a market order for the open.` });
                onQueued();
            } else {
                const filled = parseFloat(data.fill.quantity);
                setStatus({ ok: true, message: `${isLong ? "Sold" : "Covered"} ${formatShares(filled)} ${ticker} at ${formatPrice(data.fill.price)} (${formatCurrency(data.fill.total)})` });
                onTrade(ticker, isLong ? -filled : filled);
            }
            refreshAccount();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't ${action} ${ticker}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
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
                    <Link href={`/trading/${ticker}`} className="portfolio-ticker">{ticker}</Link>
                    <span className={`position-side ${isLong ? "long" : "short"}`}>{isLong ? "LONG" : "SHORT"}</span>
                </td>
                <td>{formatShares(shares)}</td>
                <td>{formatCurrency(avgCost)}</td>
                <td title={error ?? undefined}>{hasPrice ? formatCurrency(price) : "—"}</td>
                <td>{hasPrice ? formatCurrency(shares * price) : "—"}</td>
                <td className={`price-change ${(dayChange ?? 0) >= 0 ? "positive" : "negative"}`}>
                    {dayChange !== null && dayPercent !== null ? `${formatSigned(dayChange)} (${dayPercent >= 0 ? "+" : ""}${dayPercent.toFixed(2)}%)` : "—"}
                </td>
                <td className={`price-change ${(gain ?? 0) >= 0 ? "positive" : "negative"}`}>
                    {gain !== null && gainPercent !== null ? `${formatSigned(gain)} (${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(2)}%)` : "—"}
                </td>
                <td>
                    <div className="portfolio-trade">
                        <TradeModeToggle mode={mode} setMode={onModeChange} disabled={!hasPrice} />
                        <div className="order-size">
                            <QuantityStepper value={stepperValue} setValue={setTradeValue} max={maxValue}
                                decimals={mode === "dollars" ? 2 : 6} prefix={mode === "dollars" ? "$" : ""} />
                            {mode === "dollars" && <span className="order-preview">≈ {formatShares(closeQuantity)} shares</span>}
                        </div>
                        <button className={isLong ? "sell-btn" : "buy-btn"} onClick={onClosePosition} disabled={submitting || !hasPrice || closeQuantity <= 0}
                            title={marketOpen ? undefined : "The market is closed: the order is queued for the open"}>
                            {marketOpen ? "" : "Queue "}{isLong ? (marketOpen ? "Sell" : "sell") : (marketOpen ? "Cover" : "cover")} {hasPrice ? formatCurrency(total) : ""}
                        </button>
                    </div>
                </td>
                <td>
                    <button className={`ai-btn ${showAnalysis ? "open" : ""}`} onClick={onAnalysisClick}
                        title={`AI ${isLong ? "hold/sell" : "hold/cover"} analysis`} aria-expanded={showAnalysis}>
                        {loadingAnalysis ? <span className="spinner-border spinner-border-sm" role="status" /> : "AI"}
                    </button>
                </td>
            </tr>
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
