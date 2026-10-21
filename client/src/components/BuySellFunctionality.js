import React, { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import TradeModeToggle from "./TradeModeToggle";
import { useAccount } from "../context/AccountContext";
import { convertValue, formatCurrency, formatShares, toOrder } from "../utils/orders";

const BuySellFunctionality = ({ ticker = "", price = 0 }) => {
    // value is a number of shares, or a dollar amount in "dollars" mode
    const [mode, setMode] = useState("shares");
    const [value, setValue] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState(null);
    const { account, refreshAccount } = useAccount();
    const { quantity, total } = toOrder({ mode, value, price });
    const formattedTotal = total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Covering a short and selling a long are always allowed (the server judges trades that go past zero). Otherwise a buy needs its
    // cost available, a new short needs 50% of its value (150% is held as collateral and its proceeds cover 100%), and during a
    // margin call neither is allowed.
    const held = account?.positions.find(position => position.ticker === ticker.toUpperCase())?.quantity ?? 0;
    const marginCall = account?.collateralShortfall > 0;
    const shortCollateral = total / 2;
    const buyBlocked = account !== null && held >= 0 && (marginCall || total > account.availableCash);
    const sellBlocked = account !== null && held <= 0 && (marginCall || shortCollateral > account.availableCash);

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
            refreshAccount();
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
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm} disabled={submitting || quantity <= 0 || buyBlocked}>Buy ${formattedTotal}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm} disabled={submitting || quantity <= 0 || sellBlocked}>Sell ${formattedTotal}</button>
            </div>
            {mode === "dollars" && (
                <p className="order-preview">≈ {formatShares(quantity)} shares at ${price}</p>
            )}
            {marginCall && (buyBlocked || sellBlocked) ? (
                <p className="text-danger">Margin call: only covers and sales of long positions are allowed until the collateral shortfall is fixed. <Link to="/deposit">Deposit</Link></p>
            ) : (
                <Fragment>
                    {buyBlocked && <p className="text-danger">Insufficient funds to buy. <Link to="/deposit">Deposit</Link></p>}
                    {sellBlocked && (
                        <p className="text-danger">
                            Insufficient collateral to short: needs {formatCurrency(shortCollateral)} available (150% of a short is held as collateral; its proceeds cover 100%).{" "}
                            <Link to="/deposit">Deposit</Link>
                        </p>
                    )}
                </Fragment>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </Fragment>
    )
};

export default BuySellFunctionality;
