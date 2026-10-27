import { Fragment } from "react";
import { formatEastern } from "@/lib/marketHours";
import { formatPrice } from "@/lib/orders";
import type { Quote } from "@/lib/types";

const formatAmount = (amount: number) => amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const DELAY_LABELS: Record<Quote["delay"], string> = { realtime: "Realtime", "end-of-day": "Last close" };

// The latest price with its change from the previous close, and, from the quote, the bid/ask and how current the price is, any
// pre-market or after-hours price (against the regular session's), and Alpaca's top of book with sizes
const Price = ({ price, previousClose, quote = null }: { price: number; previousClose: number | null; quote?: Quote | null }) => {
    const change = previousClose ? price - previousClose : 0;
    const percentChange = previousClose ? (change / previousClose) * 100 : 0;
    const isPositive = change >= 0;

    return (
        <Fragment>
            <div className="price-container">
                <span className="current-price">
                    {formatAmount(price)} <span className="currency">USD</span>
                    {previousClose !== null && (
                        <span className={`price-change ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? " +" : " "}{change.toFixed(2)} ({isPositive ? "+" : ""}{percentChange.toFixed(2)}%)
                        </span>
                    )}
                </span>
            </div>
            {quote && (
                <p className="quote-details">
                    {quote.bid !== null && quote.ask !== null && (
                        <span title={quote.spread === "simulated" ? "No bid/ask data on this Alpha Vantage plan: a simulated spread around the last price" : undefined}>
                            Bid {formatPrice(quote.bid)} · Ask {formatPrice(quote.ask)}{quote.spread === "simulated" ? " (simulated)" : ""} ·{" "}
                        </span>
                    )}
                    {DELAY_LABELS[quote.delay]} · as of {quote.delay === "end-of-day"
                        ? new Date(quote.quoteTime).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })
                        : formatEastern(quote.quoteTime)}
                </p>
            )}
            {quote?.extendedHoursPrice != null && (
                <p className="quote-details">
                    Extended hours {formatAmount(quote.extendedHoursPrice)}
                    <span className={`price-change ${quote.extendedHoursPrice >= price ? "positive" : "negative"}`}>
                        {" "}{quote.extendedHoursPrice >= price ? "+" : ""}{((quote.extendedHoursPrice - price) / price * 100).toFixed(2)}%
                    </span>
                </p>
            )}
            {quote?.book && (
                <p className="quote-details" title={quote.book.feed === "iex"
                    ? "The IEX exchange's best bid and offer (Alpaca's free feed), which can be wider than the national best above"
                    : "The national best bid and offer from all U.S. exchanges (Alpaca SIP feed)"}>
                    {quote.book.feed.toUpperCase()} book: {quote.book.bidSize.toLocaleString("en-US")} × {formatPrice(quote.book.bid)}
                    {" / "}{formatPrice(quote.book.ask)} × {quote.book.askSize.toLocaleString("en-US")}
                    {quote.book.lastPrice !== null && ` · last ${formatPrice(quote.book.lastPrice)}${quote.book.lastSize !== null ? ` × ${quote.book.lastSize.toLocaleString("en-US")}` : ""}`}
                </p>
            )}
        </Fragment>
    )
};

export default Price;
