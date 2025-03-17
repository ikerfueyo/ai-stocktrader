import React, { Fragment, useState } from "react";
import PropTypes from "prop-types";

const BuySellFunctionality = (props) => {
    const [quantity, setQuantity] = useState(1);
    const total = (quantity * props.price).toFixed(2);

    const onSubmitForm = async e => {
        e.preventDefault();
        try {
            const date = new Date().toISOString();
            const type = e.currentTarget.id === "buyButton" ? "BUY" : "SELL";
            const transaction = { date, type, ticker: props.ticker, price: props.price, quantity, total };
            const response = await fetch(`http://localhost:5001/trading/${props.ticker}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transaction })
            });
            console.log(response);
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
                <button className="buy-btn" id="buyButton" onClick={onSubmitForm}>Buy ${total}</button>
                <button className="sell-btn" id="sellButton" onClick={onSubmitForm}>Sell ${total}</button>
            </div>
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