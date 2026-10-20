import React, { Fragment, useState } from "react";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { convertValue, formatShares, toOrder } from "../utils/orders";

const BuySellFunctionality = ({ ticker = "", price = 0 }) => {
    // value is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState("shares");
    const [value, setValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState(null);
    const { quantity, total } = toOrder({ mode, value, price });
    const formattedTotal = total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const onModeChange = (nextMode) => {
        if (nextMode === mode) return;
        setValue(convertValue(nextMode, value, price));
        setMode(nextMode);
    };

    const onSubmitForm = async e => {
        e.preventDefault();
        const type = e.currentTarget.id === "buyButton" ? "BUY" : "SELL";
        setSubmitting(true);
        setStatus(null);
        try {
            const date = new Date().toISOString();
            const transaction = { date, type, ticker, price, quantity, total };
            await axios.post(`/trading/${ticker}`, { transaction });
            setStatus({ ok: true, message: `${type} ${formatShares(quantity)} ${ticker} for $${formattedTotal}` });
        } catch (error) {
            console.error(error.message);
            setStatus({ ok: false, message: `Couldn't ${type.toLowerCase()} ${ticker}: ${error.response?.data?.error ?? error.message}` });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Fragment>
            <div className="container">
                <TradeModeToggle mode={mode} setMode={onModeChange} />
                <QuantityStepper value={value} setValue={setValue} decimals={mode === "dollars" ? 2 : 6} prefix={mode === "dollars" ? "$" : ""} />
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm} disabled={submitting || quantity <= 0}>Buy ${formattedTotal}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm} disabled={submitting || quantity <= 0}>Sell ${formattedTotal}</button>
            </div>
            {mode === "dollars" && (
                <p className="order-preview">≈ {formatShares(quantity)} shares at ${price}</p>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </Fragment>
    )
};

export default BuySellFunctionality;
