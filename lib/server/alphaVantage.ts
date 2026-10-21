import "server-only";
import axios from "axios";
import { singleton } from "./cache";
import { UpstreamError } from "./errors";
import type { DailySeries } from "../types";

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
// Premium price data: "delayed" (15 min) or "realtime". Without it, even premium keys only get end-of-day prices. Set to "" to turn off.
const ALPHA_VANTAGE_ENTITLEMENT = process.env.ALPHA_VANTAGE_ENTITLEMENT ?? "delayed";

// Alpha Vantage rejects more than 5 requests a second ("Burst pattern detected"), so requests from every route start at least 300ms apart (at most 4 a second).
// Each caller reserves the next free slot synchronously, so parallel calls (one price per position) queue up in order.
const ALPHA_VANTAGE_SPACING_MS = 300;
const alphaVantageSlot = singleton("alphaVantageSlot", () => ({ next: 0 }));
const waitForAlphaVantageSlot = () => {
    const now = Date.now();
    const start = Math.max(now, alphaVantageSlot.next);
    alphaVantageSlot.next = start + ALPHA_VANTAGE_SPACING_MS;
    return new Promise(resolve => setTimeout(resolve, start - now));
};

// Alpha Vantage answers rate limits and bad symbols with a 200 and a "Note"/"Information"/"Error Message" body
const fetchAlphaVantage = async <T>(params: Record<string, string | number>, expectedKey: string): Promise<T> => {
    await waitForAlphaVantageSlot();
    const response = await axios.get(ALPHA_VANTAGE_URL, {
        params: { ...params, apikey: ALPHA_VANTAGE_API_KEY },
        // Alpha Vantage response times vary a lot (5-30s observed, even for small responses)
        timeout: 30000
    });
    const data = response.data;
    if (!data?.[expectedKey]) {
        // Alpha Vantage replies {} both for unknown symbols (when an entitlement is sent) and during its own price-data outages
        if (typeof data === "object" && data !== null && Object.keys(data).length === 0) {
            throw new UpstreamError(`Alpha Vantage returned no data for ${params.symbol ?? params.tickers}. The ticker may not exist, or Alpha Vantage may be having problems; try again shortly.`);
        }
        throw new UpstreamError(data?.["Error Message"] || data?.Note || data?.Information || `Unexpected response from Alpha Vantage: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data as T;
};

// Below this relevance score an article only mentions a ticker in passing (market roundups, "12 stocks moving" lists)
export const MIN_NEWS_RELEVANCE = 0.3;

export interface NewsItem {
    title: string;
    summary: string;
    published: string;
    tickers: { ticker: string; relevance: number; sentiment: number }[];
}

// The parts of a NEWS_SENTIMENT article used here; scores are strings
interface NewsFeed {
    feed: {
        title: string;
        summary: string;
        time_published: string;
        ticker_sentiment?: { ticker: string; relevance_score: string; ticker_sentiment_score: string }[];
    }[];
}

// Newest first, with each ticker's relevance to the article (0 to 1) and Alpha Vantage's sentiment score for it (-1 bearish to 1 bullish).
// The news endpoint writes share classes with a hyphen (BRK-A), while prices use a dot (BRK.A).
export const fetchNews = async (params: Record<string, string | number> = {}): Promise<NewsItem[]> => {
    const data = await fetchAlphaVantage<NewsFeed>({ function: "NEWS_SENTIMENT", sort: "LATEST", ...params }, "feed");
    return data.feed.map(item => ({
        title: item.title,
        summary: item.summary,
        published: item.time_published,
        tickers: (item.ticker_sentiment ?? []).map(sentiment => ({
            ticker: sentiment.ticker,
            relevance: parseFloat(sentiment.relevance_score),
            sentiment: parseFloat(sentiment.ticker_sentiment_score)
        }))
    }));
};

export const fetchTickerNews = async (ticker: string): Promise<NewsItem[]> => {
    const symbol = ticker.replaceAll(".", "-");
    const news = (await fetchNews({ tickers: symbol })).filter(item => item.tickers.some(({ ticker, relevance }) => ticker === symbol && relevance >= MIN_NEWS_RELEVANCE));
    if (news.length === 0) {
        throw new UpstreamError(`No recent news found for ${ticker}`, 404);
    }
    return news;
};

export const fetchDailySeries = (ticker: string, outputsize: "compact" | "full") => fetchAlphaVantage<DailySeries>({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize, ...(ALPHA_VANTAGE_ENTITLEMENT && { entitlement: ALPHA_VANTAGE_ENTITLEMENT }) }, "Time Series (Daily)");

// Prices are cached for 60s, so the header's /api/account and the Portfolio page's /api/portfolio share one Alpha Vantage call per ticker
const PRICE_CACHE_MS = 60000;
const priceCache = singleton("priceCache", () => new Map<string, { promise: Promise<number>; expires: number }>());

// The last price fetched for each ticker, used to value a position while its price can't be fetched (lost on restart)
const lastKnownPrices = singleton("lastKnownPrices", () => new Map<string, number>());
// For local testing only: PRICE_OVERRIDES='{"TSTA": 120}' fixes those tickers' prices without calling Alpha Vantage
const PRICE_OVERRIDES: Record<string, number> = JSON.parse(process.env.PRICE_OVERRIDES || "{}");

// With the entitlement, the newest bar is today's partial day, so its close is the current price
export const fetchLatestPrice = (ticker: string): Promise<number> => {
    if (PRICE_OVERRIDES[ticker] !== undefined) return Promise.resolve(PRICE_OVERRIDES[ticker]);
    const cached = priceCache.get(ticker);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = fetchDailySeries(ticker, "compact").then(data => {
        const timeSeries = data["Time Series (Daily)"];
        const latestDate = Object.keys(timeSeries).sort().at(-1)!;
        const price = parseFloat(timeSeries[latestDate]["4. close"]);
        lastKnownPrices.set(ticker, price);
        return price;
    });
    priceCache.set(ticker, { promise, expires: Date.now() + PRICE_CACHE_MS });
    // Don't keep a failure (rate limit, outage) around for the next request
    promise.catch(() => {
        if (priceCache.get(ticker)?.promise === promise) priceCache.delete(ticker);
    });
    return promise;
};

// Current prices for several tickers. One failing doesn't fail the rest: it falls back to its last known price (if any) and is
// listed in staleTickers, so it's flagged in the UI and never used to approve a risky action or trigger a buy-in.
export const fetchPrices = async (tickers: string[], label: string) => {
    const results = await Promise.allSettled(tickers.map(ticker => fetchLatestPrice(ticker)));
    const prices: Record<string, number> = {};
    const staleTickers: string[] = [];
    const errors: Record<string, string> = {};
    tickers.forEach((ticker, index) => {
        const result = results[index];
        if (result.status === "fulfilled") {
            prices[ticker] = result.value;
            return;
        }
        console.error(`${label}: ${ticker}: ${result.reason.message}`);
        staleTickers.push(ticker);
        errors[ticker] = result.reason.message;
        if (lastKnownPrices.has(ticker)) prices[ticker] = lastKnownPrices.get(ticker)!;
    });
    return { prices, staleTickers, errors };
};
