import React, { Fragment } from "react";
import PropTypes from "prop-types";
import formatAmount from "../formatAmount";

const Price = (props) => {
    const isPositive = props.priceChange >= 0;
    
    return (
        <Fragment>
            <div className="price-container">
                <span className="current-price">
                    {formatAmount(props.price)} <span className="currency">USD</span>
                    <span
                        className={`price-change ${isPositive ? "positive" : "negative"}`}
                    >
                        {isPositive ? " +" : " "}{formatAmount(props.priceChange)} ({isPositive ? "+" : ""}{formatAmount(props.percentChange)}%)
                    </span>
                </span>
            </div>
        </Fragment>
    )
};

Price.propTypes = {
    price: PropTypes.number,
    priceChange: PropTypes.number,
    percentChange: PropTypes.number
};

Price.defaultProps = {
    price: 0,
    priceChange: 0,
    percentChange: 0
};

export default Price;