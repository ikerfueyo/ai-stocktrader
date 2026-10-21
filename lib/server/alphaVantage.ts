import "server-only";
import axios from "axios";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { UpstreamError } from "./errors";
import { roundPrice, type Dividend, type Split } from "./account";
import { easternParts, easternTime, parseEasternTimestamp, sessionOn } from "../marketHours";
import type { DailySeries, Quote, QuoteDelay } from "../types";

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

// A premium endpoint the API key's plan doesn't include. Alpha Vantage still answers it, with artificial sample data and a
// "message", so the reply must not be used.
export class NotEntitledError extends UpstreamError {}

// Alpha Vantage answers rate limits and bad symbols with a 200 and a "Note"/"Information"/"Error Message" body. Its burst limit can
// trip even with the spacing above during a long run of calls (such as syncing a portfolio's corporate actions), so a "Burst
// pattern detected" reply is retried after a pause, up to twice.
const fetchAlphaVantage = async <T>(params: Record<string, string | number>, expectedKey: string, attempt = 0): Promise<T> => {
    await waitForAlphaVantageSlot();
    const response = await axios.get(ALPHA_VANTAGE_URL, {
        params: { ...params, apikey: ALPHA_VANTAGE_API_KEY },
        // Alpha Vantage response times vary a lot (5-30s observed, even for small responses)
        timeout: 30000
    });
    const data = response.data;
    if (typeof data?.message === "string" && /premium endpoint/i.test(data.message)) {
        throw new NotEntitledError(`${params.function} isn't included in this Alpha Vantage plan`);
    }
    if (!data?.[expectedKey]) {
        // Alpha Vantage replies {} both for unknown symbols (when an entitlement is sent) and during its own price-data outages
        if (typeof data === "object" && data !== null && Object.keys(data).length === 0) {
            throw new UpstreamError(`Alpha Vantage returned no data for ${params.symbol ?? params.tickers}. The ticker may not exist, or Alpha Vantage may be having problems; try again shortly.`);
        }
        if (attempt < 2 && typeof data?.Information === "string" && /burst pattern/i.test(data.Information)) {
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
            return fetchAlphaVantage<T>(params, expectedKey, attempt + 1);
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

// Quotes are cached for 60s, so the header's /api/account, the Portfolio page's /api/portfolio and a trade share one Alpha Vantage
// call per ticker (one per 100 tickers with the bulk endpoints)
const QUOTE_CACHE_MS = 60000;
const quoteCache = singleton("quoteCache", () => new Map<string, CacheEntry<Quote>>());

// The last price fetched for each ticker, used to value a position while its price can't be fetched (lost on restart)
const lastKnownPrices = singleton("lastKnownPrices", () => new Map<string, number>());
// For local testing only: PRICE_OVERRIDES='{"TSTA": 120}' fixes those tickers' prices without calling Alpha Vantage
const PRICE_OVERRIDES: Record<string, number> = JSON.parse(process.env.PRICE_OVERRIDES || "{}");

// Without quoted bid/ask prices, fills use a simulated spread of SIMULATED_SPREAD_BPS basis points of the price (at least a cent),
// centered on the last price. 0 turns it off, so trades fill at the last price.
const SIMULATED_SPREAD_BPS = Number(process.env.SIMULATED_SPREAD_BPS ?? 5);

const simulatedSpread = (price: number): Pick<Quote, "bid" | "ask" | "spread"> => {
    if (!(SIMULATED_SPREAD_BPS > 0)) return { bid: null, ask: null, spread: "none" };
    const half = Math.max(0.01, price * SIMULATED_SPREAD_BPS / 10000) / 2;
    return { bid: roundPrice(price - half), ask: roundPrice(price + half), spread: "simulated" };
};

// When a bulk endpoint turns out not to be in the key's plan, skip it for an hour rather than spending a call per quote finding out
const unavailableUntil = singleton("alphaVantageUnavailable", () => new Map<string, number>());
const isAvailable = (endpoint: string) => (unavailableUntil.get(endpoint) ?? 0) <= Date.now();
const markUnavailable = (endpoint: string, error: unknown) => {
    if (error instanceof NotEntitledError) {
        if (isAvailable(endpoint)) console.warn(`${error.message}; using the fallback for an hour`);
        unavailableUntil.set(endpoint, Date.now() + 3600000);
    }
};

interface BulkQuotes {
    data: { symbol: string; timestamp: string; close: string; previous_close: string }[];
}
interface BulkBidAsk {
    data: { symbol: string; timestamp: string; bid_price: string; ask_price: string }[];
}
const realtimeParams = (tickers: string[]) => ({ symbol: tickers.join(","), datatype: "json", ...(ALPHA_VANTAGE_ENTITLEMENT && { entitlement: ALPHA_VANTAGE_ENTITLEMENT }) });
const bySymbol = <T extends { symbol: string }>(rows: T[]) => new Map(rows.map(row => [row.symbol.toUpperCase(), row]));
const quoteDelay = (): QuoteDelay => ALPHA_VANTAGE_ENTITLEMENT === "realtime" ? "realtime" : "delayed";

// A quote from the compact daily series, for keys without the bulk realtime endpoints. With the entitlement, today's bar is the
// partial day, so its close is the current (realtime or 15-minute delayed) price; otherwise it's the last session's close.
const dailyQuote = async (ticker: string): Promise<Quote> => {
    const timeSeries = (await fetchDailySeries(ticker, "compact"))["Time Series (Daily)"];
    const [latestDate, previousDate] = Object.keys(timeSeries).sort().reverse();
    const price = parseFloat(timeSeries[latestDate]["4. close"]);
    const now = new Date();
    const session = sessionOn(latestDate);
    const closeTime = session?.close ?? easternTime(latestDate, "16:00");
    // Today's bar is still moving until the (delayed) price reaches the close; after that it's the session's closing price
    const delayMs = ALPHA_VANTAGE_ENTITLEMENT === "realtime" ? 0 : 15 * 60000;
    const live = latestDate === easternParts(now).dateKey && Boolean(ALPHA_VANTAGE_ENTITLEMENT) && now.getTime() - delayMs < closeTime.getTime();
    const delay: QuoteDelay = live ? quoteDelay() : "end-of-day";
    const quoteTime = live ? new Date(now.getTime() - delayMs) : closeTime;
    return {
        ticker, price,
        previousClose: previousDate ? parseFloat(timeSeries[previousDate]["4. close"]) : null,
        ...simulatedSpread(price),
        quoteTime: quoteTime.toISOString(),
        delay
    };
};

// Quotes for several tickers from the bulk realtime endpoints (100 symbols per call), with quoted bid/ask when the plan has it.
// A ticker the bulk reply leaves out, or every ticker when the plan lacks the endpoint, falls back to dailyQuote.
const loadQuotes = (tickers: string[]): Map<string, Promise<Quote>> => {
    if (!isAvailable("REALTIME_BULK_QUOTES")) {
        return new Map(tickers.map(ticker => [ticker, dailyQuote(ticker)]));
    }
    const chunks = Array.from({ length: Math.ceil(tickers.length / 100) }, (_, i) => tickers.slice(i * 100, i * 100 + 100));
    const results = new Map<string, Promise<Quote>>();
    for (const chunk of chunks) {
        const quotes = fetchAlphaVantage<BulkQuotes>({ function: "REALTIME_BULK_QUOTES", ...realtimeParams(chunk) }, "data").then(({ data }) => bySymbol(data));
        const bidAsk = isAvailable("REALTIME_BULK_BID_ASK_PRICES")
            ? fetchAlphaVantage<BulkBidAsk>({ function: "REALTIME_BULK_BID_ASK_PRICES", ...realtimeParams(chunk) }, "data")
                .then(({ data }) => bySymbol(data), error => {
                    markUnavailable("REALTIME_BULK_BID_ASK_PRICES", error);
                    return new Map<string, BulkBidAsk["data"][number]>();
                })
            : Promise.resolve(new Map<string, BulkBidAsk["data"][number]>());
        for (const ticker of chunk) {
            results.set(ticker, quotes.then(async rows => {
                const row = rows.get(ticker);
                if (!row) return dailyQuote(ticker);
                const price = parseFloat(row.close);
                const quoted = (await bidAsk).get(ticker);
                const bid = quoted ? parseFloat(quoted.bid_price) : NaN;
                const ask = quoted ? parseFloat(quoted.ask_price) : NaN;
                return {
                    ticker, price,
                    previousClose: parseFloat(row.previous_close) || null,
                    ...(bid > 0 && ask >= bid ? { bid, ask, spread: "quoted" as const } : simulatedSpread(price)),
                    quoteTime: parseEasternTimestamp(row.timestamp).toISOString(),
                    delay: quoteDelay()
                };
            }, error => {
                markUnavailable("REALTIME_BULK_QUOTES", error);
                if (error instanceof NotEntitledError) return dailyQuote(ticker);
                throw error;
            }));
        }
    }
    return results;
};

// The latest quote for each ticker, in order, as promises (one ticker failing doesn't fail the others). Cached tickers are reused;
// the rest are fetched together.
export const fetchQuotes = (tickers: string[]): Promise<Quote>[] => {
    const symbols = tickers.map(ticker => ticker.toUpperCase());
    const missing = [...new Set(symbols)].filter(ticker => PRICE_OVERRIDES[ticker] === undefined && !((quoteCache.get(ticker)?.expires ?? 0) > Date.now()));
    const loaded = missing.length > 0 ? loadQuotes(missing) : new Map<string, Promise<Quote>>();
    return symbols.map(ticker => {
        if (PRICE_OVERRIDES[ticker] !== undefined) {
            const price = PRICE_OVERRIDES[ticker];
            return Promise.resolve({ ticker, price, previousClose: null, bid: null, ask: null, spread: "none", quoteTime: new Date().toISOString(), delay: "realtime" });
        }
        return cachePromise(quoteCache, ticker, QUOTE_CACHE_MS, () => loaded.get(ticker) ?? loadQuotes([ticker]).get(ticker)!).then(quote => {
            lastKnownPrices.set(ticker, quote.price);
            return quote;
        });
    });
};

export const fetchQuote = (ticker: string): Promise<Quote> => fetchQuotes([ticker])[0];

export const fetchLatestPrice = async (ticker: string): Promise<number> => (await fetchQuote(ticker)).price;

// Current prices for several tickers. One failing doesn't fail the rest: it falls back to its last known price (if any) and is
// listed in staleTickers, so it's flagged in the UI and never used to approve a risky action or trigger a buy-in.
export const fetchPrices = async (tickers: string[], label: string) => {
    const results = await Promise.allSettled(fetchQuotes(tickers));
    const prices: Record<string, number> = {};
    const quotes: Record<string, Quote> = {};
    const staleTickers: string[] = [];
    const errors: Record<string, string> = {};
    tickers.forEach((ticker, index) => {
        const result = results[index];
        if (result.status === "fulfilled") {
            prices[ticker] = result.value.price;
            quotes[ticker] = result.value;
            return;
        }
        console.error(`${label}: ${ticker}: ${result.reason.message}`);
        staleTickers.push(ticker);
        errors[ticker] = result.reason.message;
        if (lastKnownPrices.has(ticker)) prices[ticker] = lastKnownPrices.get(ticker)!;
    });
    return { prices, quotes, staleTickers, errors };
};

interface MarketStatusReply {
    markets: { market_type: string; region: string; current_status: string }[];
}

// Whether Alpha Vantage reports the U.S. equity market open, which catches unscheduled closures the holiday calendar can't know
export const fetchUsMarketOpen = async (): Promise<boolean> => {
    const { markets } = await fetchAlphaVantage<MarketStatusReply>({ function: "MARKET_STATUS" }, "markets");
    const us = markets.find(({ market_type, region }) => market_type === "Equity" && region === "United States");
    if (!us) throw new UpstreamError("Alpha Vantage's market status has no U.S. equity market");
    return us.current_status.toLowerCase() === "open";
};

interface SplitsReply {
    data: { effective_date: string; split_factor: string }[];
}
interface DividendsReply {
    data: { ex_dividend_date: string; payment_date: string; amount: string }[];
}
const isDate = (value: string | undefined): value is string => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");

// A ticker's split and dividend history (Alpha Vantage SPLITS and DIVIDENDS; an unknown ticker has none)
export const fetchCorporateActions = async (ticker: string): Promise<{ splits: Split[]; dividends: Dividend[] }> => {
    const [splits, dividends] = await Promise.all([
        fetchAlphaVantage<SplitsReply>({ function: "SPLITS", symbol: ticker }, "data"),
        fetchAlphaVantage<DividendsReply>({ function: "DIVIDENDS", symbol: ticker }, "data")
    ]);
    return {
        splits: splits.data
            .filter(row => isDate(row.effective_date) && parseFloat(row.split_factor) > 0)
            .map(row => ({ ticker, exDate: row.effective_date, factor: parseFloat(row.split_factor) })),
        dividends: dividends.data
            .filter(row => isDate(row.ex_dividend_date) && parseFloat(row.amount) > 0)
            .map(row => ({ ticker, exDate: row.ex_dividend_date, paymentDate: isDate(row.payment_date) ? row.payment_date : null, amount: parseFloat(row.amount) }))
    };
};
