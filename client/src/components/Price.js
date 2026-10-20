import React, { Fragment } from "react";

const formatAmount = (amount) => Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 });

const Price = ({ price = 0, priceChange = 0, percentChange = 0 }) => {
    const isPositive = priceChange >= 0;

    return (
        <Fragment>
            <div className="price-container">
                <span className="current-price">
                    {formatAmount(price)} <span className="currency">USD</span>
                    <span
                        className={`price-change ${isPositive ? "positive" : "negative"}`}
                    >
                        {isPositive ? " +" : " "}{formatAmount(priceChange)} ({isPositive ? "+" : ""}{percentChange}%)
                    </span>
                </span>
            </div>
        </Fragment>
    )
};

export default Price;
