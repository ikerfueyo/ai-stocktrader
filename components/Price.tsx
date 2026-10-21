import { Fragment } from "react";

const formatAmount = (amount: number | string) => Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 });

// The values arrive formatted to 2 decimals (strings), as TradingInterface computes them
const Price = ({ price = 0, priceChange = 0, percentChange = 0 }: { price?: number | string; priceChange?: number | string; percentChange?: number | string }) => {
    const isPositive = Number(priceChange) >= 0;

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
