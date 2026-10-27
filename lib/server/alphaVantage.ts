import "server-only";
import axios from "axios";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { UpstreamError } from "./httpError";
import { rateLimiter } from "./rateLimit";
import { roundPrice, type Dividend, type Split } from "./account";
import { easternParts, easternTime, marketStatus, parseEasternTimestamp, sessionOn } from "../marketHours";
import type { EpsEstimate, NextReport, QuarterResult } from "./earnings";
import type { CompanyOverview, DailyBar, DailySeries, IntradayBar, MarketMovers, Mover, Quote, QuoteDelay, SymbolMatch } from "../types";

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
// Price requests ask for realtime data. Without the entitlement, even premium keys only get end-of-day prices; a key that isn't
// entitled to realtime gets a "Note" back, which fails the request.
const REALTIME = { entitlement: "realtime" };

// Alpha Vantage rejects more than 5 requests a second ("Burst pattern detected") and more than the plan's per-minute limit
// (ALPHA_VANTAGE_REQUESTS_PER_MINUTE, default 150), so requests from every route start at least 300ms apart (at most 4 a second)
// and at most that many in any minute
const waitForAlphaVantageSlot = rateLimiter("alphaVantage", 300, Number(process.env.ALPHA_VANTAGE_REQUESTS_PER_MINUTE ?? 150));

// A premium endpoint the API key's plan doesn't include. Alpha Vantage still answers it, with artificial sample data and a
// "message", so the reply must not be used.
export class NotEntitledError extends UpstreamError {}

// When an endpoint turns out not to be in the key's plan, skip it for an hour rather than spending a call per quote finding out
const unavailableUntil = singleton("alphaVantageUnavailable", () => new Map<string, number>());
const isAvailable = (endpoint: string) => (unavailableUntil.get(endpoint) ?? 0) <= Date.now();
const markUnavailable = (endpoint: string, error: unknown) => {
    if (error instanceof NotEntitledError) {
        if (isAvailable(endpoint)) console.warn(`${error.message}; using the fallback for an hour`);
        unavailableUntil.set(endpoint, Date.now() + 3600000);
    }
};

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

// A CSV endpoint (EARNINGS_CALENDAR) as rows keyed by its header. Errors come back as the usual JSON body. Values may be quoted.
const fetchAlphaVantageCsv = async (params: Record<string, string | number>): Promise<Record<string, string>[]> => {
    await waitForAlphaVantageSlot();
    const response = await axios.get<string>(ALPHA_VANTAGE_URL, { params: { ...params, apikey: ALPHA_VANTAGE_API_KEY }, timeout: 30000, responseType: "text" });
    const text = response.data.trim();
    if (text.startsWith("{")) {
        const data = JSON.parse(text);
        throw new UpstreamError(data["Error Message"] || data.Note || data.Information || `Unexpected response from Alpha Vantage: ${text.slice(0, 200)}`);
    }
    const splitLine = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].slice(0, -1).map(([, value]) =>
        value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value);
    const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const keys = splitLine(header ?? "");
    return lines.map(line => {
        const values = splitLine(line);
        return Object.fromEntries(keys.map((key, i) => [key, values[i] ?? ""]));
    });
};

// Below this relevance score an article only mentions a ticker in passing (market roundups, "12 stocks moving" lists)
export const MIN_NEWS_RELEVANCE = 0.3;

export interface NewsItem {
    title: string;
    url: string | null;
    summary: string;
    published: string;
    tickers: { ticker: string; relevance: number; sentiment: number }[];
}

// The companies an article is mainly about: its most relevant tickers. Analyst notes also tag the bank that wrote them
// ("JPMorgan cuts target for Bunge" is BG 1.0, JPM 0.63), which this leaves out.
export const mainTickers = (item: NewsItem) => {
    const top = Math.max(...item.tickers.map(({ relevance }) => relevance));
    return item.tickers.filter(({ relevance }) => relevance >= Math.max(MIN_NEWS_RELEVANCE, top - 0.1));
};

// The parts of a NEWS_SENTIMENT article used here; scores are strings
interface NewsFeed {
    feed: {
        title: string;
        url?: string;
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
        url: typeof item.url === "string" && /^https?:\/\//.test(item.url) ? item.url : null,
        summary: item.summary,
        published: item.time_published,
        tickers: (item.ticker_sentiment ?? []).map(sentiment => ({
            ticker: sentiment.ticker,
            relevance: parseFloat(sentiment.relevance_score),
            sentiment: parseFloat(sentiment.ticker_sentiment_score)
        }))
    }));
};

// A NEWS_SENTIMENT publication time ("20261020T223723", in UTC: the newest articles would otherwise be hours in the future) as an
// ISO timestamp (unchanged if it doesn't parse)
export const parseNewsTime = (published: string): string => {
    const date = new Date(published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?.*$/, (_, y, mo, d, h, mi, sec = "00") => `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`));
    return Number.isNaN(date.getTime()) ? published : date.toISOString();
};

// A ticker's recent news (relevance at least MIN_NEWS_RELEVANCE), cached for 5 minutes per ticker, so the Trading page's news list
// and a fresh analysis share one call; 404 when there's none
const tickerNewsCache = singleton("tickerNewsCache", () => new Map<string, CacheEntry<NewsItem[]>>());
export const fetchTickerNews = (ticker: string): Promise<NewsItem[]> => cachePromise(tickerNewsCache, ticker.toUpperCase(), 5 * 60000, async () => {
    const symbol = ticker.replaceAll(".", "-");
    const news = (await fetchNews({ tickers: symbol })).filter(item => item.tickers.some(({ ticker, relevance }) => ticker === symbol && relevance >= MIN_NEWS_RELEVANCE));
    if (news.length === 0) {
        throw new UpstreamError(`No recent news found for ${ticker}`, 404);
    }
    return news;
});

// Daily closes by date for the performance history, cached for 12 hours per ticker and size (compact is about the last 100 sessions)
const closesCache = singleton("dailyClosesCache", () => new Map<string, CacheEntry<Record<string, number>>>());
export const fetchDailyCloses = (ticker: string, outputsize: "compact" | "full") =>
    cachePromise(closesCache, `${ticker}|${outputsize}`, 12 * 3600000, async () => {
        const series = (await fetchDailySeries(ticker, outputsize))["Time Series (Daily)"];
        return Object.fromEntries(Object.entries(series).map(([date, bar]) => [date, parseFloat(bar["4. close"])]));
    });

export const fetchDailySeries = (ticker: string, outputsize: "compact" | "full") => fetchAlphaVantage<DailySeries>({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize, ...REALTIME }, "Time Series (Daily)");

// Quotes are cached for 15s, so the header's /api/account, the Portfolio page's /api/portfolio and a trade share one Alpha Vantage
// call per ticker (one per 100 tickers with the bulk endpoints) while staying close to the realtime price
const QUOTE_CACHE_MS = 15000;
const quoteCache = singleton("quoteCache", () => new Map<string, CacheEntry<Quote>>());

// The last price fetched for each ticker, used to value a position while its price can't be fetched (lost on restart)
const lastKnownPrices = singleton("lastKnownPrices", () => new Map<string, number>());
// For local testing only: PRICE_OVERRIDES='{"TSTA": 120}' fixes those tickers' prices without calling Alpha Vantage
const PRICE_OVERRIDES: Record<string, number> = JSON.parse(process.env.PRICE_OVERRIDES || "{}");

// Without quoted bid/ask prices, fills use a simulated spread of SIMULATED_SPREAD_BPS basis points of the price (at least a cent,
// but at most half the price, so a sub-cent stock's bid stays positive), centered on the last price. 0 turns it off, so trades
// fill at the last price.
const SIMULATED_SPREAD_BPS = Number(process.env.SIMULATED_SPREAD_BPS ?? 5);

const simulatedSpread = (price: number): Pick<Quote, "bid" | "ask" | "spread"> => {
    if (!(SIMULATED_SPREAD_BPS > 0)) return { bid: null, ask: null, spread: "none" };
    const half = Math.min(Math.max(0.01, price * SIMULATED_SPREAD_BPS / 10000), price / 2) / 2;
    return { bid: roundPrice(price - half), ask: roundPrice(price + half), spread: "simulated" };
};

interface BulkQuotes {
    data: {
        symbol: string; timestamp: string; open: string; high: string; low: string; close: string; volume: string; previous_close: string;
        // Empty during the regular session
        extended_hours_quote?: string;
    }[];
}
interface BulkBidAsk {
    data: { symbol: string; timestamp: string; bid_price: string; ask_price: string }[];
}
const positiveOrNull = (value: string | undefined): number | null => {
    const number = parseFloat(value ?? "");
    return number > 0 ? number : null;
};
const realtimeParams = (tickers: string[]) => ({ symbol: tickers.join(","), datatype: "json", ...REALTIME });
const bySymbol = <T extends { symbol: string }>(rows: T[]) => new Map(rows.map(row => [row.symbol.toUpperCase(), row]));

// A quote from the compact daily series, for keys without the bulk realtime endpoints. Today's bar is the partial day, so its
// close is the current price; otherwise it's the last session's close.
const dailyQuote = async (ticker: string): Promise<Quote> => {
    const timeSeries = (await fetchDailySeries(ticker, "compact"))["Time Series (Daily)"];
    const [latestDate, previousDate] = Object.keys(timeSeries).sort().reverse();
    const price = parseFloat(timeSeries[latestDate]["4. close"]);
    const now = new Date();
    const session = sessionOn(latestDate);
    const closeTime = session?.close ?? easternTime(latestDate, "16:00");
    // Today's bar is still moving until the close; after that it's the session's closing price
    const live = latestDate === easternParts(now).dateKey && now.getTime() < closeTime.getTime();
    const delay: QuoteDelay = live ? "realtime" : "end-of-day";
    const quoteTime = live ? now : closeTime;
    const bar = timeSeries[latestDate];
    return {
        ticker, price,
        previousClose: previousDate ? parseFloat(timeSeries[previousDate]["4. close"]) : null,
        ...simulatedSpread(price),
        quoteTime: quoteTime.toISOString(),
        delay,
        open: parseFloat(bar["1. open"]), high: parseFloat(bar["2. high"]), low: parseFloat(bar["3. low"]), volume: parseFloat(bar["5. volume"]),
        extendedHoursPrice: null
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
                    delay: "realtime",
                    open: positiveOrNull(row.open), high: positiveOrNull(row.high), low: positiveOrNull(row.low), volume: positiveOrNull(row.volume),
                    extendedHoursPrice: positiveOrNull(row.extended_hours_quote)
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
            return Promise.resolve({ ticker, price, previousClose: null, bid: null, ask: null, spread: "none", quoteTime: new Date().toISOString(), delay: "realtime",
                open: null, high: null, low: null, volume: null, extendedHoursPrice: null
            });
        }
        return cachePromise(quoteCache, ticker, QUOTE_CACHE_MS, () => loaded.get(ticker) ?? loadQuotes([ticker]).get(ticker)!).then(quote => {
            lastKnownPrices.set(ticker, quote.price);
            return quote;
        });
    });
};

export const fetchQuote = (ticker: string): Promise<Quote> => fetchQuotes([ticker])[0];

// How old a quote may be during a scheduled session and still fill a trade, approve a risky one or trigger a buy-in
const MAX_QUOTE_AGE_MS = 15 * 60000;

// Whether a quote is too old to trade on: during a scheduled NYSE session (the calendar, so MARKET_HOURS_OVERRIDE=open outside one
// still trades on the last close), an end-of-day quote, such as yesterday's close before today's bar exists, or one more than 15
// minutes old. Outside sessions the last close is the current price.
export const isStaleQuote = (quote: Pick<Quote, "quoteTime" | "delay">, now = new Date()): boolean =>
    marketStatus(now).open && (quote.delay !== "realtime" || now.getTime() - new Date(quote.quoteTime).getTime() > MAX_QUOTE_AGE_MS);

export const fetchLatestPrice = async (ticker: string): Promise<number> => (await fetchQuote(ticker)).price;

// Current prices for several tickers. One failing doesn't fail the rest: it falls back to its last known price (if any) and is
// listed in staleTickers, so it's flagged in the UI and never used to approve a risky action or trigger a buy-in. A quote that's
// too old to trade on (isStaleQuote) is kept for display but listed in staleTickers too.
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
            if (isStaleQuote(result.value)) staleTickers.push(ticker);
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

interface OverviewReply {
    Symbol: string;
    Name: string;
    AssetType: string;
    Exchange: string;
    Sector: string;
    Industry: string;
    MarketCapitalization: string;
    PERatio: string;
    ForwardPE: string;
    DividendYield: string;
    Beta: string;
    "52WeekHigh": string;
    "52WeekLow": string;
    ExDividendDate: string;
    DividendDate: string;
    AnalystTargetPrice: string;
    AnalystRatingStrongBuy: string;
    AnalystRatingBuy: string;
    AnalystRatingHold: string;
    AnalystRatingSell: string;
    AnalystRatingStrongSell: string;
}
// Alpha Vantage writes missing numbers as "None" or "-"
const numberOrNull = (value: string | undefined) => {
    const parsed = parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : null;
};
const textOrNull = (value: string | undefined) => value && value !== "None" && value !== "-" ? value : null;

// A company's profile and key figures (Alpha Vantage OVERVIEW), cached for 24 hours. Funds and unknown tickers have none (404).
const overviewCache = singleton("overviewCache", () => new Map<string, CacheEntry<CompanyOverview>>());
export const fetchCompanyOverview = (ticker: string) => cachePromise(overviewCache, ticker, 24 * 3600000, async (): Promise<CompanyOverview> => {
    const data = await fetchAlphaVantage<OverviewReply>({ function: "OVERVIEW", symbol: ticker }, "Symbol").catch(error => {
        throw error instanceof UpstreamError && /returned no data/.test(error.message) ? new UpstreamError(`No company overview for ${ticker}`, 404) : error;
    });
    return {
        ticker, name: data.Name, assetType: textOrNull(data.AssetType), exchange: textOrNull(data.Exchange),
        sector: textOrNull(data.Sector), industry: textOrNull(data.Industry),
        marketCap: numberOrNull(data.MarketCapitalization), peRatio: numberOrNull(data.PERatio), forwardPe: numberOrNull(data.ForwardPE),
        dividendYield: numberOrNull(data.DividendYield), beta: numberOrNull(data.Beta),
        week52High: numberOrNull(data["52WeekHigh"]), week52Low: numberOrNull(data["52WeekLow"]),
        exDividendDate: textOrNull(data.ExDividendDate), dividendDate: textOrNull(data.DividendDate),
        analystTargetPrice: numberOrNull(data.AnalystTargetPrice),
        analystRatings: analystRatings(data)
    };
});

// The rating counts, or null when no analyst covers the stock (all missing or zero)
const analystRatings = (data: OverviewReply): CompanyOverview["analystRatings"] => {
    const counts = [data.AnalystRatingStrongBuy, data.AnalystRatingBuy, data.AnalystRatingHold, data.AnalystRatingSell, data.AnalystRatingStrongSell].map(value => numberOrNull(value) ?? 0);
    if (counts.every(count => count === 0)) return null;
    const [strongBuy, buy, hold, sell, strongSell] = counts;
    return { strongBuy, buy, hold, sell, strongSell };
};

// Earnings data changes at most daily (on a report or an estimate revision), so it's cached for 12 hours per ticker. A fund or a
// company without coverage gets {} (an UpstreamError), which the analysis goes ahead without.
const EARNINGS_CACHE_MS = 12 * 3600000;

interface EarningsReply {
    quarterlyEarnings: { fiscalDateEnding: string; reportedDate: string; reportedEPS: string; estimatedEPS: string; surprisePercentage: string }[];
}
// Reported quarters with their estimates and surprises (Alpha Vantage EARNINGS), newest first
const earningsCache = singleton("earningsCache", () => new Map<string, CacheEntry<QuarterResult[]>>());
export const fetchEarnings = (ticker: string) => cachePromise(earningsCache, ticker, EARNINGS_CACHE_MS, async () => {
    const { quarterlyEarnings } = await fetchAlphaVantage<EarningsReply>({ function: "EARNINGS", symbol: ticker }, "quarterlyEarnings");
    return quarterlyEarnings.flatMap(({ fiscalDateEnding, reportedDate, reportedEPS, estimatedEPS, surprisePercentage }) => {
        const reportedEps = numberOrNull(reportedEPS);
        if (reportedEps === null || !isDate(fiscalDateEnding) || !isDate(reportedDate)) return [];
        const surprise = numberOrNull(surprisePercentage);
        return [{ fiscalDateEnding, reportedDate, reportedEps, estimatedEps: numberOrNull(estimatedEPS), surprise: surprise === null ? null : surprise / 100 }];
    });
});

interface EarningsEstimatesReply {
    estimates: Record<string, string | null>[];
}
// Consensus EPS estimates per fiscal quarter and year, with the averages 30 and 90 days ago (Alpha Vantage EARNINGS_ESTIMATES)
const estimatesCache = singleton("earningsEstimatesCache", () => new Map<string, CacheEntry<EpsEstimate[]>>());
export const fetchEarningsEstimates = (ticker: string) => cachePromise(estimatesCache, ticker, EARNINGS_CACHE_MS, async () => {
    const { estimates } = await fetchAlphaVantage<EarningsEstimatesReply>({ function: "EARNINGS_ESTIMATES", symbol: ticker }, "estimates");
    const value = (text: string | null) => numberOrNull(text ?? undefined);
    return estimates.flatMap((row): EpsEstimate[] => {
        const average = value(row.eps_estimate_average);
        const period = row.horizon === "fiscal quarter" ? "quarter" : row.horizon === "fiscal year" ? "year" : null;
        if (average === null || period === null || !isDate(row.date ?? undefined)) return [];
        return [{
            fiscalDateEnding: row.date!, period, average,
            analysts: value(row.eps_estimate_analyst_count),
            average30DaysAgo: value(row.eps_estimate_average_30_days_ago), average90DaysAgo: value(row.eps_estimate_average_90_days_ago),
            revisionsUp30Days: value(row.eps_estimate_revision_up_trailing_30_days), revisionsDown30Days: value(row.eps_estimate_revision_down_trailing_30_days)
        }];
    });
});

// The next scheduled earnings report within 3 months (Alpha Vantage EARNINGS_CALENDAR), or null if none is scheduled
const nextReportCache = singleton("nextReportCache", () => new Map<string, CacheEntry<NextReport | null>>());
export const fetchNextReport = (ticker: string) => cachePromise(nextReportCache, ticker, EARNINGS_CACHE_MS, async () => {
    const rows = await fetchAlphaVantageCsv({ function: "EARNINGS_CALENDAR", symbol: ticker, horizon: "3month" });
    const row = rows.filter(({ reportDate }) => isDate(reportDate)).sort((a, b) => a.reportDate.localeCompare(b.reportDate))[0];
    return row ? { reportDate: row.reportDate, fiscalDateEnding: isDate(row.fiscalDateEnding) ? row.fiscalDateEnding : null, timeOfDay: textOrNull(row.timeOfTheDay) } : null;
});

// The last month of 5-minute bars, pre-market and after-hours included (Alpha Vantage TIME_SERIES_INTRADAY, with the
// entitlement), newest last, cached for 60s. Times are Eastern ("YYYY-MM-DD HH:MM:SS").
const intradayCache = singleton("intradayCache", () => new Map<string, CacheEntry<IntradayBar[]>>());
export const fetchIntraday = (ticker: string) => cachePromise(intradayCache, ticker, 60000, async () => {
    const data = await fetchAlphaVantage<{ "Time Series (5min)": Record<string, DailyBar> }>({
        function: "TIME_SERIES_INTRADAY", symbol: ticker, interval: "5min", outputsize: "full", extended_hours: "true",
        ...REALTIME
    }, "Time Series (5min)");
    return Object.entries(data["Time Series (5min)"]).sort(([a], [b]) => a.localeCompare(b)).map(([time, bar]) => ({
        time, open: parseFloat(bar["1. open"]), high: parseFloat(bar["2. high"]), low: parseFloat(bar["3. low"]), close: parseFloat(bar["4. close"]), volume: parseFloat(bar["5. volume"])
    }));
});

interface TopMoversReply {
    last_updated?: string;
    top_gainers: { ticker: string; price: string; change_amount: string; change_percentage: string; volume: string }[];
    top_losers: TopMoversReply["top_gainers"];
    most_actively_traded: TopMoversReply["top_gainers"];
}
// Today's top 20 gainers, losers and most traded tickers (Alpha Vantage TOP_GAINERS_LOSERS, realtime), cached for a minute. They
// include warrants, units and ETFs; the route keeps the tradable stocks.
const moversCache = singleton("topMoversCache", () => new Map<string, CacheEntry<MarketMovers>>());
export const fetchTopMovers = () => cachePromise(moversCache, "movers", 60000, async (): Promise<MarketMovers> => {
    const data = await fetchAlphaVantage<TopMoversReply>({ function: "TOP_GAINERS_LOSERS", ...REALTIME }, "top_gainers");
    const toMovers = (rows: TopMoversReply["top_gainers"]): Mover[] => rows.map(row => ({
        ticker: row.ticker,
        price: parseFloat(row.price),
        change: parseFloat(row.change_amount),
        changePercent: parseFloat(row.change_percentage) / 100,
        volume: parseFloat(row.volume)
    })).filter(({ price, changePercent }) => Number.isFinite(price) && Number.isFinite(changePercent));
    return {
        gainers: toMovers(data.top_gainers),
        losers: toMovers(data.top_losers ?? []),
        mostActive: toMovers(data.most_actively_traded ?? []),
        updatedAt: data.last_updated ? parseEasternTimestamp(data.last_updated).toISOString() : null
    };
});

// An active U.S. listing (Alpha Vantage LISTING_STATUS, a CSV of every active stock and ETF), as of the latest trading day
export interface Listing {
    symbol: string;
    name: string;
    exchange: string;
    assetType: string;
}
const listingCache = singleton("listingCache", () => new Map<string, CacheEntry<Listing[]>>());
export const fetchListings = () => cachePromise(listingCache, "active", 6 * 3600000, async () =>
    (await fetchAlphaVantageCsv({ function: "LISTING_STATUS", state: "active" }))
        .filter(row => row.symbol)
        .map(({ symbol, name, exchange, assetType }) => ({ symbol, name, exchange, assetType })));

interface SymbolSearchReply {
    bestMatches: Record<string, string>[];
}
// Tickers matching a search (Alpha Vantage SYMBOL_SEARCH), U.S. listings only, since trades are in dollars on NYSE hours; cached for
// 24 hours per query
const searchCache = singleton("symbolSearchCache", () => new Map<string, CacheEntry<SymbolMatch[]>>());
export const searchSymbols = (query: string) => cachePromise(searchCache, query.toUpperCase(), 24 * 3600000, async () => {
    const { bestMatches } = await fetchAlphaVantage<SymbolSearchReply>({ function: "SYMBOL_SEARCH", keywords: query }, "bestMatches");
    const matches = bestMatches.map(match => ({ symbol: match["1. symbol"], name: match["2. name"], type: match["3. type"], region: match["4. region"], currency: match["8. currency"] }));
    return matches.filter(({ region }) => region === "United States");
});

// Whether a symbol is a non-U.S. listing, which Alpha Vantage writes with an exchange suffix (TSCO.LON, SHOP.TRT, SAP.DEX); U.S.
// share classes have a single letter (BRK.A). Those listings trade in other currencies and hours, so they can't be traded here.
export const isForeignListing = (ticker: string): boolean => /\.[A-Z]{2,}$/.test(ticker.toUpperCase());
