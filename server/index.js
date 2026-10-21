const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { roundCents, formatCurrency, computePositions, valueAccount, reducesPosition, assessTrade, assessWithdrawal, planBuyIn } = require("./account");
require("dotenv").config();
const { clerkMiddleware, getAuth } = require("@clerk/express");
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
// Premium price data: "delayed" (15 min) or "realtime". Without it, even premium keys only get end-of-day prices. Set to "" to turn off.
const ALPHA_VANTAGE_ENTITLEMENT = process.env.ALPHA_VANTAGE_ENTITLEMENT ?? "delayed";
const axios = require("axios");
const app = express();
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });

// Middleware
// The CRA dev server proxies API calls, so they're same-origin; CLIENT_ORIGIN allows a client served from elsewhere
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000" }));
app.use(express.json());

// HELPERS
// Error reported to the client with the given status, such as 400 for a bad request
class HttpError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// Error from a third-party API, reported to the client as 502
class UpstreamError extends HttpError {
    constructor(message, status = 502) {
        super(message, status);
    }
}

const sendError = (res, error) => {
    // pg throws an AggregateError with an empty message when every address for the host fails (e.g. ::1 and 127.0.0.1)
    const message = error.message || error.errors?.map(e => e.message).join("; ") || error.code || "Unknown error";
    console.error(`${res.req.method} ${res.req.originalUrl}: ${message}`);
    let status = 500;
    if (error instanceof HttpError) {
        status = error.status;
    } else if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error instanceof OpenAI.APIConnectionTimeoutError) {
        status = 504;
    } else if (error instanceof OpenAI.APIError) {
        status = 502;
    }
    res.status(status).json({ error: message });
};

// Without the keys clerkMiddleware fails every request, so stop here instead
if (!process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    throw new Error("server/.env needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (Clerk dashboard → API keys)");
}
// Every route needs a signed-in Clerk user (the client sends its session token as a Bearer header), so anonymous callers can't
// read accounts or spend the Alpha Vantage and OpenAI quota. req.userId scopes every account query to that user.
const requireUser = (req, res, next) => {
    const { userId } = getAuth(req);
    if (!userId) {
        sendError(res, new HttpError("Sign in required", 401));
        return;
    }
    req.userId = userId;
    next();
};
app.use(clerkMiddleware());
app.use(requireUser);

// Alpha Vantage rejects more than 5 requests a second ("Burst pattern detected"), so requests from every route start at least 300ms apart (at most 4 a second).
// Each caller reserves the next free slot synchronously, so parallel calls (one price per position) queue up in order.
const ALPHA_VANTAGE_SPACING_MS = 300;
let nextAlphaVantageSlot = 0;
const waitForAlphaVantageSlot = () => {
    const now = Date.now();
    const start = Math.max(now, nextAlphaVantageSlot);
    nextAlphaVantageSlot = start + ALPHA_VANTAGE_SPACING_MS;
    return new Promise(resolve => setTimeout(resolve, start - now));
};

// Alpha Vantage answers rate limits and bad symbols with a 200 and a "Note"/"Information"/"Error Message" body
const fetchAlphaVantage = async (params, expectedKey) => {
    await waitForAlphaVantageSlot();
    const response = await axios.get(ALPHA_VANTAGE_URL, {
        params: { ...params, apikey: ALPHA_VANTAGE_API_KEY },
        // Alpha Vantage response times vary a lot (5-30s observed, even for small responses)
        timeout: 30000
    });
    const data = response.data;
    if (!data[expectedKey]) {
        // Alpha Vantage replies {} both for unknown symbols (when an entitlement is sent) and during its own price-data outages
        if (typeof data === "object" && data !== null && Object.keys(data).length === 0) {
            throw new UpstreamError(`Alpha Vantage returned no data for ${params.symbol ?? params.tickers}. The ticker may not exist, or Alpha Vantage may be having problems; try again shortly.`);
        }
        throw new UpstreamError(data["Error Message"] || data.Note || data.Information || `Unexpected response from Alpha Vantage: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
};

// Caches a promise per key for ms milliseconds, shared by concurrent callers. Failures aren't kept.
const cachePromise = (cache, key, ms, load) => {
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = load();
    cache.set(key, { promise, expires: Date.now() + ms });
    promise.catch(() => {
        if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
};

// Below this relevance score an article only mentions a ticker in passing (market roundups, "12 stocks moving" lists)
const MIN_NEWS_RELEVANCE = 0.3;

// Newest first, with each ticker's relevance to the article (0 to 1) and Alpha Vantage's sentiment score for it (-1 bearish to 1 bullish).
// The news endpoint writes share classes with a hyphen (BRK-A), while prices use a dot (BRK.A).
const fetchNews = async (params = {}) => {
    const data = await fetchAlphaVantage({ function: "NEWS_SENTIMENT", sort: "LATEST", ...params }, "feed");
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

// The companies an article is mainly about: its most relevant tickers. Analyst notes also tag the bank that wrote them
// ("JPMorgan cuts target for Bunge" is BG 1.0, JPM 0.63), which this leaves out.
const mainTickers = (item) => {
    const top = Math.max(...item.tickers.map(({ relevance }) => relevance));
    return item.tickers.filter(({ relevance }) => relevance >= Math.max(MIN_NEWS_RELEVANCE, top - 0.1));
};

// "20261020T223723" -> "2026-10-20 22:37"
const formatPublished = (published = "") => published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}).*$/, "$1-$2-$3 $4:$5");

const formatNews = (news) => news.map(item => `Published: ${formatPublished(item.published)}\nTitle: ${item.title}\nSummary: ${item.summary}`).join("\n\n");

const askAnalyst = async (content, options = {}) => {
    const response = await openai.chat.completions.create({
        model: "gpt-6-luna",
        // Reasoning off: it didn't change Luna's verdicts on this prompt, and temperature (0 for the JSON calls) is only accepted without it
        reasoning_effort: "none",
        messages: [
            { role: "system", content: "You are a financial news sentiment analyst. Your task is to analyze the titles and summaries of news articles related to stocks and determine their sentiment, giving more weight to recent articles. Provide a response based on the given prompt." },
            { role: "user", content }
        ],
        ...options
    });
    return response.choices[0].message.content.trim();
};

const analyzeNews = (news, prompt, options) => askAnalyst(`${formatNews(news)}\n\n${prompt}`, options);

const parseJson = (content) => {
    try {
        return JSON.parse(content);
    } catch {
        throw new UpstreamError("AI returned invalid JSON");
    }
};

const fetchTickerNews = async (ticker) => {
    const symbol = ticker.replaceAll(".", "-");
    const news = (await fetchNews({ tickers: symbol })).filter(item => item.tickers.some(({ ticker, relevance }) => ticker === symbol && relevance >= MIN_NEWS_RELEVANCE));
    if (news.length === 0) {
        throw new UpstreamError(`No recent news found for ${ticker}`, 404);
    }
    return news;
};

const toTickers = (list, limit) => (Array.isArray(list) ? list : [])
    .filter(ticker => typeof ticker === "string")
    .map(ticker => ticker.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, limit);

// A ticker's buy/hold/sell verdict and analysis, shared by the Trading page and the rankings (which only list tickers whose verdict
// agrees with their side) and the Portfolio page (whose position verdict is derived from it), so they can't contradict each other.
// Cached, with the news it was based on, so all of them see the same answer; the rankings extend it.
const ANALYSIS_CACHE_MS = 30 * 60 * 1000;
const VERDICTS = ["BUY", "HOLD", "SELL"];
const analysisCache = new Map();

const analyzeTicker = (ticker) => cachePromise(analysisCache, ticker, ANALYSIS_CACHE_MS, async () => {
    const news = await fetchTickerNews(ticker);
    const prompt = `Based on the news below, recommend what an investor should do with stock ${ticker} now: buy it, hold off, or sell it (which includes selling it short). Respond with JSON only, in the form {"verdict": "BUY" | "HOLD" | "SELL", "analysis": "..."}. The verdict is BUY if the news points to the share price rising, SELL if it points to the share price falling, and HOLD only if the news is genuinely balanced or too thin to call either way. The analysis is a brief one-paragraph explanation that must agree with the verdict.`;
    const { verdict, analysis } = parseJson(await analyzeNews(news, prompt, { response_format: { type: "json_object" }, temperature: 0 }));
    if (!VERDICTS.includes(verdict) || typeof analysis !== "string" || !analysis.trim()) {
        throw new UpstreamError("AI returned an incomplete analysis");
    }
    return { verdict, analysis: analysis.trim(), news };
});

// What a ticker's verdict means for an open position: a long is sold on SELL and held otherwise (there's no buying more from the
// Portfolio page), and a short is covered on BUY and kept open otherwise
const POSITION_VERDICTS = {
    long: { BUY: "HOLD", HOLD: "HOLD", SELL: "SELL" },
    short: { BUY: "COVER", HOLD: "HOLD", SELL: "HOLD" }
};
const positionAnalysisCache = new Map();

// The Portfolio page's hold/sell (or hold/cover) verdict, taken from analyzeTicker, and a paragraph written for the position that
// explains it. Cached by verdict too, so a refreshed ticker analysis with a new verdict gets a new paragraph.
const analyzePosition = async (ticker, side) => {
    const { verdict: tickerVerdict, news } = await analyzeTicker(ticker);
    const verdict = POSITION_VERDICTS[side][tickerVerdict];
    return cachePromise(positionAnalysisCache, `${ticker}:${side}:${verdict}`, ANALYSIS_CACHE_MS, async () => {
        const position = side === "long" ? `The user owns shares of ${ticker}.` : `The user has a short position in ${ticker}.`;
        const action = {
            long: { HOLD: "hold their shares", SELL: "sell their shares" },
            short: { HOLD: "keep their short position open", COVER: "cover their short position (buy the shares back)" }
        }[side][verdict];
        const prompt = `${position} Based on the news below, the recommendation is that the user should ${action}. Write a brief one-paragraph analysis explaining why, which must agree with that recommendation.`;
        const analysis = await analyzeNews(news, prompt, { temperature: 0 });
        if (!analysis) {
            throw new UpstreamError("AI returned an empty analysis");
        }
        return { verdict, analysis };
    });
};

// Rankings: the market news is grouped by the stocks it's about, the most bullish and most bearish stocks (by Alpha Vantage's
// sentiment) go to the model, which shortlists up to RANKING_CANDIDATES per side, and each candidate is kept only if its own
// analysis (analyzeTicker) gives the matching verdict, until RANKING_SIZE are confirmed
const RANKINGS_CACHE_MS = 30 * 60 * 1000;
const RANKING_SIZE = 5;
const RANKING_CANDIDATES = 15;
const STOCKS_PER_SIDE = 30;
// Average sentiment beyond which Alpha Vantage labels news somewhat bullish or bearish
const MIN_STOCK_SENTIMENT = 0.15;
const ARTICLES_PER_STOCK = 4;
const rankingsCache = new Map();

// Checks candidates in order, a couple more than still needed at a time, since some won't be confirmed
const confirmRankings = async (candidates, verdict) => {
    const picks = [];
    const errors = [];
    const checked = [];
    let next = 0;
    while (picks.length < RANKING_SIZE && next < candidates.length) {
        const batch = candidates.slice(next, next + RANKING_SIZE - picks.length + 2);
        next += batch.length;
        const results = await Promise.allSettled(batch.map(ticker => analyzeTicker(ticker)));
        results.forEach((result, i) => {
            checked.push(`${batch[i]} ${result.status === "rejected" ? `failed (${result.reason.message})` : result.value.verdict}`);
            if (result.status === "rejected") {
                errors.push(result.reason);
            } else if (result.value.verdict === verdict && picks.length < RANKING_SIZE) {
                picks.push(batch[i]);
            }
        });
    }
    return { picks, errors, checked };
};

const buildRankings = async () => {
    const news = await fetchNews({ limit: 1000 });
    // Skips crypto and forex symbols (CRYPTO:BTC, FOREX:USD), preferred shares (ARR-P-C), and Nasdaq symbols whose 5th letter marks
    // a preferred share, warrant, unit or right (BWBBP)
    const newsByTicker = new Map();
    for (const item of news) {
        for (const { ticker, sentiment } of mainTickers(item).filter(({ ticker }) => /^([A-Z]{1,4}|[A-Z]{4}[A-OQSTVX-Z])(-[A-Z])?$/.test(ticker))) {
            const stock = newsByTicker.get(ticker) ?? { ticker, articles: [], sentimentSum: 0 };
            stock.articles.push(item);
            stock.sentimentSum += sentiment;
            newsByTicker.set(ticker, stock);
        }
    }
    // Strength grows with the average sentiment and, more slowly, with the number of articles agreeing with it
    const stockStrength = ({ articles, sentimentSum }) => sentimentSum / Math.sqrt(articles.length);
    const averageSentiment = ({ articles, sentimentSum }) => sentimentSum / articles.length;
    const byStrength = [...newsByTicker.values()].sort((a, b) => stockStrength(b) - stockStrength(a));
    const bullish = byStrength.filter(stock => averageSentiment(stock) >= MIN_STOCK_SENTIMENT).slice(0, STOCKS_PER_SIDE);
    const bearish = byStrength.filter(stock => averageSentiment(stock) <= -MIN_STOCK_SENTIMENT).reverse().slice(0, STOCKS_PER_SIDE);
    const stocks = [...bullish, ...bearish];
    if (stocks.length === 0) {
        throw new UpstreamError("Not enough recent market news to rank stocks");
    }

    const groupedNews = stocks
        .map(({ ticker, articles }) => `Stock: ${ticker} (${articles.length} ${articles.length === 1 ? "article" : "articles"})\n\n${formatNews(articles.slice(0, ARTICLES_PER_STOCK))}`)
        .join("\n\n---\n\n");
    const prompt = `The news above is the latest market news, grouped by the stock each article is about, newest first. Pick up to ${RANKING_CANDIDATES} stocks to buy and up to ${RANKING_CANDIDATES} stocks to sell, strongest case first, using only the stock tickers listed. A buy needs news that is clearly positive for the share price, and a sell news that is clearly negative. Leave out stocks whose news is mixed or neutral, and never list a stock on both sides. Respond with JSON only, in the form {"buy": ["TICKER", ...], "sell": ["TICKER", ...]}.`;
    const parsed = parseJson(await askAnalyst(`${groupedNews}\n\n${prompt}`, { response_format: { type: "json_object" }, temperature: 0 }));

    const listed = new Set(stocks.map(({ ticker }) => ticker));
    const buy = toTickers(parsed.buy, RANKING_CANDIDATES).filter(ticker => listed.has(ticker));
    const sell = toTickers(parsed.sell, RANKING_CANDIDATES).filter(ticker => listed.has(ticker));
    // The rankings link to the Trading page, which uses price symbols (BRK.A)
    const toCandidates = (tickers, other) => tickers.filter(ticker => !other.includes(ticker)).map(ticker => ticker.replaceAll("-", "."));
    const buyCandidates = toCandidates(buy, sell);
    const sellCandidates = toCandidates(sell, buy);
    if (buyCandidates.length === 0 && sellCandidates.length === 0) {
        throw new UpstreamError("AI returned no rankings");
    }

    const [confirmedBuys, confirmedSells] = await Promise.all([confirmRankings(buyCandidates, "BUY"), confirmRankings(sellCandidates, "SELL")]);
    console.log(`GET /rankings: ${news.length} articles on ${newsByTicker.size} stocks; sent ${bullish.length} bullish and ${bearish.length} bearish stocks to the AI; `
        + `buy candidates: ${confirmedBuys.checked.join(", ") || "none"}; sell candidates: ${confirmedSells.checked.join(", ") || "none"}`);
    const errors = [...confirmedBuys.errors, ...confirmedSells.errors];
    if (confirmedBuys.picks.length === 0 && confirmedSells.picks.length === 0 && errors.length > 0) {
        throw errors[0];
    }
    // Keep the listed tickers' analyses at least as long as the rankings, so the Trading page shows the analysis that confirmed them
    const expires = Date.now() + RANKINGS_CACHE_MS;
    for (const ticker of [...confirmedBuys.picks, ...confirmedSells.picks]) {
        const cached = analysisCache.get(ticker);
        if (cached) cached.expires = Math.max(cached.expires, expires);
    }
    return { buy: confirmedBuys.picks, sell: confirmedSells.picks };
};

const getPositions = async (userId, ticker) => {
    const { rows } = ticker
        ? await pool.query('SELECT * FROM transactions WHERE user_id = $1 AND UPPER(ticker) = $2 ORDER BY "date", id', [userId, ticker])
        : await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]);
    return computePositions(rows).positions;
};

// A user's trade history, open positions and total cash (the trades' cash ledger plus net deposits)
const getAccount = async (userId) => {
    const [{ rows: transactions }, { rows: [{ net }] }] = await Promise.all([
        pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date", id', [userId]),
        pool.query(`SELECT COALESCE(SUM(CASE "type" WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0) AS net FROM cash_transfers WHERE user_id = $1`, [userId])
    ]);
    const netTransfers = parseFloat(net);
    const { positions, cash } = computePositions(transactions);
    return { transactions, netTransfers, positions, totalCash: roundCents(cash + netTransfers) };
};

// Serializes each user's account changes (collateral checks, buy-ins, trades and withdrawals), so a check can't pass on cash that
// another request is about to spend. Users don't wait on each other. It's an in-process queue, so it assumes a single server process.
const accountQueues = new Map();
const withAccountLock = (userId, fn) => {
    const run = (accountQueues.get(userId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    accountQueues.set(userId, tail);
    // Forget the queue once nothing else has joined it
    tail.then(() => {
        if (accountQueues.get(userId) === tail) accountQueues.delete(userId);
    });
    return run;
};

const fetchDailySeries = (ticker, outputsize) => fetchAlphaVantage({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize, ...(ALPHA_VANTAGE_ENTITLEMENT && { entitlement: ALPHA_VANTAGE_ENTITLEMENT }) }, "Time Series (Daily)");

// Prices are cached for 60s, so the header's /account and the Portfolio page's /portfolio share one Alpha Vantage call per ticker
const PRICE_CACHE_MS = 60000;
const priceCache = new Map();

// The last price fetched for each ticker, used to value a position while its price can't be fetched (lost on restart)
const lastKnownPrices = new Map();
// For local testing only: PRICE_OVERRIDES='{"TSTA": 120}' fixes those tickers' prices without calling Alpha Vantage
const PRICE_OVERRIDES = JSON.parse(process.env.PRICE_OVERRIDES || "{}");

// With the entitlement, the newest bar is today's partial day, so its close is the current price
const fetchLatestPrice = (ticker) => {
    if (PRICE_OVERRIDES[ticker] !== undefined) return Promise.resolve(PRICE_OVERRIDES[ticker]);
    const cached = priceCache.get(ticker);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = fetchDailySeries(ticker, "compact").then(data => {
        const timeSeries = data["Time Series (Daily)"];
        const latestDate = Object.keys(timeSeries).sort().at(-1);
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
const fetchPrices = async (tickers, label) => {
    const results = await Promise.allSettled(tickers.map(ticker => fetchLatestPrice(ticker)));
    const prices = {};
    const staleTickers = [];
    const errors = {};
    tickers.forEach((ticker, index) => {
        const result = results[index];
        if (result.status === "fulfilled") {
            prices[ticker] = result.value;
            return;
        }
        console.error(`${label}: ${ticker}: ${result.reason.message}`);
        staleTickers.push(ticker);
        errors[ticker] = result.reason.message;
        if (lastKnownPrices.has(ticker)) prices[ticker] = lastKnownPrices.get(ticker);
    });
    return { prices, staleTickers, errors };
};

const shortTickers = (positions) => positions.filter(({ quantity }) => quantity < 0).map(({ ticker }) => ticker);

// Automatic buy-in (see planBuyIn): when total cash is below 130% of the shorts' value, cover just enough of every short to get back
// to 150%, and sell longs only if covering every short leaves negative cash. The trades are marked reason = 'LIQUIDATION'.
// Prices only arrive with requests, so this runs lazily, from GET /account, GET /portfolio and after each trade. Call it inside
// withAccountLock. It's recalculated from the database each time, so running it again right away does nothing.
const enforceCollateral = async (userId, label) => {
    const { positions, totalCash } = await getAccount(userId);
    const shorts = shortTickers(positions);
    if (shorts.length === 0) return [];
    const shortPrices = await fetchPrices(shorts, label);
    if (valueAccount({ positions, totalCash, ...shortPrices }).marginStatus !== "buy_in") return [];
    // Longs are only priced when a buy-in is due, in case covering every short isn't enough
    const longPrices = await fetchPrices(positions.filter(({ quantity }) => quantity > 0).map(({ ticker }) => ticker), label);
    const { trades, remainingDeficit } = planBuyIn({
        positions, totalCash,
        prices: { ...longPrices.prices, ...shortPrices.prices },
        staleTickers: [...longPrices.staleTickers, ...shortPrices.staleTickers]
    });
    if (trades.length === 0) return [];
    const client = await pool.connect();
    const inserted = [];
    try {
        await client.query("BEGIN");
        for (const { type, ticker, price, quantity, total } of trades) {
            const { rows } = await client.query(
                `INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total, reason) VALUES($1, now(), $2, $3, $4, $5, $6, 'LIQUIDATION') RETURNING *`,
                [userId, type, ticker, price, quantity, total]
            );
            inserted.push(rows[0]);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    const summary = inserted.map(({ type, ticker, quantity, price }) => `${type} ${parseFloat(quantity)} ${ticker} @ ${price}`).join(", ");
    console.log(`${label}: collateral buy-in for ${userId}: ${summary}${remainingDeficit > 0 ? `; ${formatCurrency(remainingDeficit)} still negative` : ""}`);
    return inserted;
};

// ROUTES
// Get up to 5 buy and 5 sell stocks from market news sentiment, each confirmed by its own analysis (Alpha Vantage + OpenAI APIs)
app.get("/rankings", async(req, res) => {
    try {
        res.json(await cachePromise(rankingsCache, "rankings", RANKINGS_CACHE_MS, buildRankings));
    } catch (error) {
        sendError(res, error);
    }
});

// Get the buy/hold/sell verdict and analysis of a stock from its news sentiment (Alpha Vantage + OpenAI APIs)
app.get("/analysis/:ticker", async(req, res) => {
    try {
        const { verdict, analysis } = await analyzeTicker(req.params.ticker.toUpperCase());
        res.json({ verdict, analysis });
    } catch (error) {
        sendError(res, error);
    }
});

// Create a transaction. Covers and sales of longs are always allowed; anything that opens or adds to a position must leave no
// collateral shortfall (assessTrade). close: true (from the Portfolio page) rejects a trade larger than the open position with 409,
// since a buy-in may have shrunk it, rather than flipping it to the other side. The buy-in check runs after the trade, so a cover
// meant to fix a shortfall goes through first.
app.post("/trading/:ticker", async(req, res) => {
    try {
        const { transaction, close = false } = req.body;
        const { date, type, ticker, price, quantity, total } = transaction;
        const trade = { type, ticker: String(ticker), price, quantity, total };
        const inserted = await withAccountLock(req.userId, async () => {
            const { transactions, netTransfers, positions } = await getAccount(req.userId);
            const reduces = reducesPosition({ positions, trade });
            if (close && !reduces) {
                throw new HttpError(`Your ${trade.ticker.toUpperCase()} position has changed (it may have been bought in to restore collateral). Refresh and try again.`, 409);
            }
            if (!reduces) {
                // Collateral depends on the shorts' current prices, except the traded ticker's, which uses the trade price
                const { positions: after } = computePositions([...transactions, trade]);
                const { prices, staleTickers } = await fetchPrices(shortTickers(after).filter(symbol => symbol !== trade.ticker.toUpperCase()), `POST /trading/${ticker}`);
                const assessment = assessTrade({ transactions, netTransfers, prices, staleTickers, trade });
                if (!assessment.allowed) {
                    throw new HttpError(assessment.message, assessment.status);
                }
            }
            const { rows } = await pool.query(
                'INSERT INTO transactions (user_id, "date", "type", ticker, price, quantity, total) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                [req.userId, date, type, ticker, price, quantity, total]
            );
            // The trade is already saved, so a failed buy-in check is only logged; the next GET /account runs it again
            await enforceCollateral(req.userId, `POST /trading/${ticker}`).catch(error => console.error(`POST /trading/${ticker}: buy-in check: ${error.message}`));
            return rows[0];
        });
        res.json(inserted);
    } catch (error) {
        sendError(res, error);
    }
});

// Get all of the user's transactions
app.get("/transactions", async(req, res) => {
    try {
        const allTransactions = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date" DESC, id DESC', [req.userId]);
        res.json(allTransactions.rows);
    } catch (error) {
        sendError(res, error);
    }
});

// Get stock data (Alpha Vantage API)
app.get("/trading/:ticker", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const data = await fetchDailySeries(ticker, "full");
        res.json(data);
    } catch (error) {
        sendError(res, error);
    }
});

// Get open positions with current prices (Alpha Vantage API, one call per position). Runs the collateral buy-in check first.
app.get("/portfolio", async(req, res) => {
    try {
        await withAccountLock(req.userId, () => enforceCollateral(req.userId, "GET /portfolio"));
        const positions = (await getPositions(req.userId)).sort((a, b) => a.ticker.localeCompare(b.ticker));
        // One ticker's price failing (rate limit, outage) shouldn't hide the rest of the portfolio
        const prices = await Promise.allSettled(positions.map(position => fetchLatestPrice(position.ticker)));
        res.json(positions.map((position, index) => {
            const result = prices[index];
            if (result.status === "fulfilled") {
                return { ...position, price: result.value, error: null };
            }
            console.error(`GET /portfolio: ${position.ticker}: ${result.reason.message}`);
            return { ...position, price: null, error: result.reason.message };
        }));
    } catch (error) {
        sendError(res, error);
    }
});

// Get total, available and restricted cash, collateral status, equity and unrealized P&L, plus the past week's buy-in trades
// (Alpha Vantage API, one call per position, shared with /portfolio by the price cache). Runs the collateral buy-in check first.
app.get("/account", async(req, res) => {
    try {
        await withAccountLock(req.userId, () => enforceCollateral(req.userId, "GET /account"));
        const { positions, totalCash } = await getAccount(req.userId);
        const { prices, staleTickers } = await fetchPrices(positions.map(({ ticker }) => ticker), "GET /account");
        const { rows: liquidations } = await pool.query(
            `SELECT * FROM transactions WHERE user_id = $1 AND reason = 'LIQUIDATION' AND "date" > now() - interval '7 days' ORDER BY "date" DESC, id DESC LIMIT 20`,
            [req.userId]
        );
        res.json({
            ...valueAccount({ positions, totalCash, prices, staleTickers }),
            positions: positions.map(({ ticker, quantity }) => ({ ticker, quantity })),
            liquidations
        });
    } catch (error) {
        sendError(res, error);
    }
});

// Create a mock deposit or withdrawal. method is a display label only, such as "Visa •••• 4242".
app.post("/transfers", async(req, res) => {
    try {
        const { type, method, amount: requestedAmount } = req.body?.transfer ?? {};
        if (type !== "DEPOSIT" && type !== "WITHDRAW") {
            throw new HttpError("Transfer type must be DEPOSIT or WITHDRAW", 400);
        }
        if (typeof method !== "string" || !method.trim()) {
            throw new HttpError("A payment method is required", 400);
        }
        const amount = roundCents(Number(requestedAmount));
        // The upper limit is what amount's DECIMAL(10, 2) column holds
        if (!(amount > 0 && amount <= 99999999.99)) {
            throw new HttpError("Amount must be between $0.01 and $99,999,999.99", 400);
        }
        const insert = () => pool.query(
            'INSERT INTO cash_transfers (user_id, "type", method, amount) VALUES($1, $2, $3, $4) RETURNING *',
            [req.userId, type, method.trim().slice(0, 255), amount]
        );
        // A deposit is always allowed and needs no lock: it can only add cash, such as to meet a margin call before the next buy-in check
        if (type === "DEPOSIT") {
            res.json((await insert()).rows[0]);
            return;
        }
        // A withdrawal only comes from available cash, never from short collateral
        const newTransfer = await withAccountLock(req.userId, async () => {
            const { positions, totalCash } = await getAccount(req.userId);
            const { prices, staleTickers } = await fetchPrices(shortTickers(positions), "POST /transfers");
            const assessment = assessWithdrawal({ positions, totalCash, prices, staleTickers, amount });
            if (!assessment.allowed) {
                throw new HttpError(assessment.message, assessment.status);
            }
            return insert();
        });
        res.json(newTransfer.rows[0]);
    } catch (error) {
        sendError(res, error);
    }
});

// Get all of the user's deposits and withdrawals
app.get("/transfers", async(req, res) => {
    try {
        const allTransfers = await pool.query('SELECT * FROM cash_transfers WHERE user_id = $1 ORDER BY "date" DESC, id DESC', [req.userId]);
        res.json(allTransfers.rows);
    } catch (error) {
        sendError(res, error);
    }
});

// Get the hold/sell (or hold/cover for shorts) verdict and analysis of an open position, derived from the ticker's own analysis
// (Alpha Vantage + OpenAI APIs)
app.get("/portfolio/:ticker/analysis", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const [position] = await getPositions(req.userId, ticker);
        if (!position) {
            throw new UpstreamError(`No open position in ${ticker}`, 404);
        }
        res.json(await analyzePosition(ticker, position.quantity > 0 ? "long" : "short"));
    } catch (error) {
        sendError(res, error);
    }
});


app.listen(5001, () => {
    console.log("server has started on port 5001");
});
