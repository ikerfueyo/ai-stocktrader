import React, { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { useAccount } from "../context/AccountContext";
import { convertValue, formatCurrency, formatShares, formatSigned, roundCents, toOrder } from "../utils/orders";

const PortfolioRow = ({ position, onTrade, setStatus }) => {
    const { ticker, quantity, avgCost, price, error } = position;
    const isLong = quantity > 0;
    const shares = Math.abs(quantity);

    // tradeValue is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState("shares");
    const [tradeValue, setTradeValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [analysis, setAnalysis] = useState(null);
    const [analysisError, setAnalysisError] = useState(null);
    const [loadingAnalysis, setLoadingAnalysis] = useState(false);
    const { refreshAccount } = useAccount();

    const hasPrice = price !== null;
    const tradePrice = hasPrice ? roundCents(price) : null;
    const maxValue = mode === "dollars" ? roundCents(shares * tradePrice) : shares;
    // A partial sell can leave the stepper above what's left of the position
    const stepperValue = Math.min(tradeValue, maxValue);
    const { quantity: closeQuantity, total } = toOrder({ mode, value: stepperValue, price: tradePrice, maxShares: shares });
    // quantity is signed, so a short gains when the price falls
    const gain = hasPrice ? (price - avgCost) * quantity : null;
    const gainPercent = hasPrice ? (gain / (shares * avgCost)) * 100 : null;

    const onModeChange = (nextMode) => {
        if (nextMode === mode) return;
        // Keep a whole-position order whole, since converting could round it a fraction of a share short
        const nextMax = nextMode === "dollars" ? roundCents(shares * tradePrice) : shares;
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
            const date = new Date().toISOString();
            const transaction = { date, type, ticker, price: tradePrice, quantity: closeQuantity, total };
            // close: the server refuses (rather than flipping the position) if a buy-in has shrunk it since this page loaded
            await axios.post(`/trading/${ticker}`, { transaction, close: true });
            setStatus({ ok: true, message: `${type} ${formatShares(closeQuantity)} ${ticker} for ${formatCurrency(total)}` });
            setMode("shares");
            setTradeValue(1);
            onTrade(ticker, isLong ? -closeQuantity : closeQuantity);
            refreshAccount();
        } catch (error) {
            console.error(error.message);
            setStatus({ ok: false, message: `Couldn't ${action} ${ticker}: ${error.response?.data?.error ?? error.message}` });
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
            const response = await axios.get(`/portfolio/${ticker}/analysis`);
            setAnalysis(response.data.analysis);
        } catch (error) {
            console.error(error.message);
            setAnalysisError(error.response?.data?.error ?? error.message);
        } finally {
            setLoadingAnalysis(false);
        }
    };

    return (
        <Fragment>
            <tr>
                <td>
                    <Link to={`/trading/${ticker}`} className="portfolio-ticker">{ticker}</Link>
                    <span className={`position-side ${isLong ? "long" : "short"}`}>{isLong ? "LONG" : "SHORT"}</span>
                </td>
                <td>{formatShares(shares)}</td>
                <td>{formatCurrency(avgCost)}</td>
                <td title={error ?? undefined}>{hasPrice ? formatCurrency(price) : "—"}</td>
                <td>{hasPrice ? formatCurrency(shares * price) : "—"}</td>
                <td className={`price-change ${gain >= 0 ? "positive" : "negative"}`}>
                    {hasPrice ? `${formatSigned(gain)} (${gainPercent >= 0 ? "+" : ""}${gainPercent.toFixed(2)}%)` : "—"}
                </td>
                <td>
                    <div className="portfolio-trade">
                        <TradeModeToggle mode={mode} setMode={onModeChange} disabled={!hasPrice} />
                        <div className="order-size">
                            <QuantityStepper value={stepperValue} setValue={setTradeValue} max={maxValue}
                                decimals={mode === "dollars" ? 2 : 6} prefix={mode === "dollars" ? "$" : ""} />
                            {mode === "dollars" && <span className="order-preview">≈ {formatShares(closeQuantity)} shares</span>}
                        </div>
                        <button className={isLong ? "sell-btn" : "buy-btn"} onClick={onClosePosition} disabled={submitting || !hasPrice || closeQuantity <= 0}>
                            {isLong ? "Sell" : "Cover"} {hasPrice ? formatCurrency(total) : ""}
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
                    <td colSpan={8}>
                        <div className="analysis-box">
                            {analysisError ? <p className="text-danger">Couldn't load AI analysis: {analysisError}</p>
                                : analysis ? <p>{analysis}</p> : <p>Loading...</p>}
                        </div>
                    </td>
                </tr>
            )}
        </Fragment>
    );
};

export default PortfolioRow;
