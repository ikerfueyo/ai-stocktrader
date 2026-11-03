import "server-only";
import { fetchQuote } from "../alphaVantage";
import { fetchQuoteBooks, isAlpacaConfigured } from "./alpaca";
import type { Quote } from "../../types";

// The one place the app gets market data from. Alpha Vantage (premium) serves everything it has: quotes and the prices fills use,
// daily and intraday bars, news with sentiment, company overviews, earnings and estimates, splits and dividends, symbol search and
// the market status. Alpaca's free data (./alpaca) adds what Alpha Vantage lacks: asset flags, the calendar and clock, and the top
// of book with sizes. Import from here rather than from a provider, so a data type can move to another provider in one place.
export * from "../alphaVantage";
export { ALPACA_DATA_FEED, fetchAlpacaAssets, fetchAlpacaCalendar, fetchAlpacaClock, fetchAlpacaCorporateActions, isAlpacaConfigured } from "./alpaca";

// A ticker's quote with Alpaca's top of book (book is null without Alpaca keys, or when the book can't be fetched: it's only
// shown, so its failure doesn't fail the quote)
export const fetchQuoteWithBook = async (ticker: string): Promise<Quote> => {
    const [quote, book] = await Promise.all([
        fetchQuote(ticker),
        isAlpacaConfigured()
            ? fetchQuoteBooks([ticker])[0].catch(error => {
                console.error(`Alpaca book for ${ticker}: ${error.message}`);
                return null;
            })
            : null
    ]);
    return { ...quote, book };
};
