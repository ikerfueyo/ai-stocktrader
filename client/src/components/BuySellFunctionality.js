import React, { Fragment, useEffect, useState } from "react";
import PropTypes from "prop-types";
import formatAmount from "../formatAmount";

const BuySellFunctionality = (props) => {
    const [quantity, setQuantity] = useState(1);
    const [notice, setNotice] = useState(null);
    const total = (quantity * props.price).toFixed(2);
    const displayTotal = formatAmount(total);

    // Hide the buy/sell notice after a few seconds
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(null), 4000);
        return () => clearTimeout(timer);
    }, [notice]);

    const onSubmitForm = async e => {
        e.preventDefault();
        try {
            // Local calendar date (YYYY-MM-DD). toISOString() is UTC, which rolls over to
            // the next day in the evening for users west of UTC (e.g. after 6pm in CST).
            const now = new Date();
            const date = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, "0"),
                String(now.getDate()).padStart(2, "0"),
            ].join("-");
            const type = e.currentTarget.id === "buyButton" ? "BUY" : "SELL";
            const transaction = { date, type, ticker: props.ticker, price: props.price, quantity, total };
            const response = await fetch(`http://localhost:5001/trading/${props.ticker}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transaction })
            });
            console.log(response);
            if (response.ok) {
                const shares = `${quantity} ${quantity === 1 ? "share" : "shares"} of ${props.ticker}`;
                setNotice({
                    type,
                    message: type === "BUY" ? `Bought ${shares} for $${displayTotal}` : `Sold ${shares} for $${displayTotal}`
                });
            }
            // window.location = "/";
        } catch (error) {
            console.error(error.message);
        }
    };

    return (
        <Fragment>
            <div className="container">
                <div className="quantity-container">
                    <button onClick={() => setQuantity((prev) => Math.max(1, prev - 1))}>-</button>
                    <input type="number" id="quantity" className="quantity-input" min="1" readOnly
                        value={quantity}
                        onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    />
                    <button onClick={() => setQuantity((prev) => prev + 1)}>+</button>
                </div>
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm}>Buy ${displayTotal}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm}>Sell ${displayTotal}</button>
            </div>
            {notice && (
                <div className={`trade-notice ${notice.type === "BUY" ? "buy" : "sell"}`}>
                    {notice.message}
                </div>
            )}
        </Fragment>
    )
};

BuySellFunctionality.propTypes = {
    ticker: PropTypes.string,
    price: PropTypes.number
};

BuySellFunctionality.defaultProps = {
    ticker: "",
    price: 0
};

export default BuySellFunctionality;