const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();
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
app.use(cors());
app.use(express.json());

// HELPERS
// Error from a third-party API, reported to the client as 502
class UpstreamError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

const sendError = (res, error) => {
    // pg throws an AggregateError with an empty message when every address for the host fails (e.g. ::1 and 127.0.0.1)
    const message = error.message || error.errors?.map(e => e.message).join("; ") || error.code || "Unknown error";
    console.error(`${res.req.method} ${res.req.originalUrl}: ${message}`);
    let status = 500;
    if (error instanceof UpstreamError) {
        status = error.status;
    } else if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error instanceof OpenAI.APIConnectionTimeoutError) {
        status = 504;
    } else if (error instanceof OpenAI.APIError) {
        status = 502;
    }
    res.status(status).json({ error: message });
};

// Alpha Vantage answers rate limits and bad symbols with a 200 and a "Note"/"Information"/"Error Message" body
const fetchAlphaVantage = async (params, expectedKey) => {
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

const fetchNews = async (params = {}) => {
    const data = await fetchAlphaVantage({ function: "NEWS_SENTIMENT", ...params }, "feed");
    return data.feed.slice(0, 250).map(item => ({ title: item.title, summary: item.summary }));
};

const analyzeNews = async (news, prompt, options = {}) => {
    const formattedNews = news.map(item => `Title: ${item.title}\nSummary: ${item.summary}`).join("\n\n");
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "You are a financial news sentiment analyst. Your task is to analyze the titles and summaries of news articles related to stocks and determine their sentiment. Provide a response based on the given prompt." },
            { role: "user", content: `${formattedNews}\n\n${prompt}` }
        ],
        ...options
    });
    return response.choices[0].message.content.trim();
};

const fetchTickerNews = async (ticker) => {
    // The news endpoint writes share classes with a hyphen (BRK-A), while prices use a dot (BRK.A)
    const news = await fetchNews({ tickers: ticker.replaceAll(".", "-") });
    if (news.length === 0) {
        throw new UpstreamError(`No recent news found for ${ticker}`, 404);
    }
    return news;
};

const toTickers = (list) => (Array.isArray(list) ? list : [])
    .filter(ticker => typeof ticker === "string")
    .map(ticker => ticker.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5);

// Quantities are stored to 6 decimal places (fractional shares); rounding stops float drift from leaving a 1e-17 position open
const roundShares = (shares) => Math.round(shares * 1e6) / 1e6;

// Net transactions (oldest first) into one position per ticker, using average cost.
// quantity is signed: sells past zero open a short (negative quantity).
const computePositions = (transactions) => {
    const positions = new Map();
    for (const { ticker, type, price, quantity: storedQuantity } of transactions) {
        const symbol = ticker.toUpperCase();
        const position = positions.get(symbol) ?? { ticker: symbol, quantity: 0, avgCost: 0 };
        const tradePrice = parseFloat(price);
        // pg returns NUMERIC columns as strings
        const quantity = parseFloat(storedQuantity);
        const delta = type === "BUY" ? quantity : -quantity;
        const held = Math.abs(position.quantity);
        if (position.quantity === 0 || Math.sign(delta) === Math.sign(position.quantity)) {
            position.avgCost = (position.avgCost * held + tradePrice * quantity) / (held + quantity);
            position.quantity = roundShares(position.quantity + delta);
        } else if (quantity <= held) {
            // Closing part of the position doesn't change its average cost
            position.quantity = roundShares(position.quantity + delta);
            if (position.quantity === 0) position.avgCost = 0;
        } else {
            // The trade flips the position; the leftover opens a new one at the trade price
            position.quantity = roundShares(position.quantity + delta);
            position.avgCost = tradePrice;
        }
        positions.set(symbol, position);
    }
    return [...positions.values()].filter(position => position.quantity !== 0);
};

const getPositions = async (ticker) => {
    const { rows } = ticker
        ? await pool.query('SELECT * FROM transactions WHERE UPPER(ticker) = $1 ORDER BY "date", id', [ticker])
        : await pool.query('SELECT * FROM transactions ORDER BY "date", id');
    return computePositions(rows);
};

const fetchDailySeries = (ticker, outputsize) => fetchAlphaVantage({ function: "TIME_SERIES_DAILY", symbol: ticker, outputsize, ...(ALPHA_VANTAGE_ENTITLEMENT && { entitlement: ALPHA_VANTAGE_ENTITLEMENT }) }, "Time Series (Daily)");

// With the entitlement, the newest bar is today's partial day, so its close is the current price
const fetchLatestPrice = async (ticker) => {
    const timeSeries = (await fetchDailySeries(ticker, "compact"))["Time Series (Daily)"];
    const latestDate = Object.keys(timeSeries).sort().at(-1);
    return parseFloat(timeSeries[latestDate]["4. close"]);
};

// ROUTES
// Get top 5 buy and sell stocks from market news sentiment (Alpha Vantage + OpenAI APIs)
app.get("/rankings", async(req, res) => {
    try {
        const news = await fetchNews({ limit: 1000 });
        const prompt = 'Based on the news below, pick the top 5 stocks to buy and the top 5 stocks to sell. Respond with JSON only, in the form {"buy": ["TICKER", ...], "sell": ["TICKER", ...]}, using stock ticker symbols.';
        const content = await analyzeNews(news, prompt, { response_format: { type: "json_object" } });

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new UpstreamError("AI returned invalid JSON");
        }
        const rankings = { buy: toTickers(parsed.buy), sell: toTickers(parsed.sell) };
        if (rankings.buy.length === 0 && rankings.sell.length === 0) {
            throw new UpstreamError("AI returned no rankings");
        }
        res.json(rankings);
    } catch (error) {
        sendError(res, error);
    }
});

// Get buy/sell analysis of a stock from its news sentiment (Alpha Vantage + OpenAI APIs)
app.get("/analysis/:ticker", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const news = await fetchTickerNews(ticker);
        const prompt = `Based on the news below, write a brief one-paragraph analysis on whether the user should buy or sell stock ${ticker}.`;
        const analysis = await analyzeNews(news, prompt);
        res.json({ analysis });
    } catch (error) {
        sendError(res, error);
    }
});

// Create a transaction
app.post("/trading/:ticker", async(req, res) => {
    try {
        const { transaction } = req.body;
        const { date, type, ticker, price, quantity, total } = transaction;
        const newTransaction = await pool.query(
            'INSERT INTO transactions ("date", "type", ticker, price, quantity, total) VALUES($1, $2, $3, $4, $5, $6) RETURNING *',
            [date, type, ticker, price, quantity, total]
        );
        res.json(newTransaction.rows[0]);
    } catch (error) {
        sendError(res, error);
    }
});

// Get all transactions
app.get("/transactions", async(req, res) => {
    try {
        const allTransactions = await pool.query('SELECT * FROM transactions ORDER BY "date" DESC, id DESC');
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

// Get open positions with current prices (Alpha Vantage API, one call per position)
app.get("/portfolio", async(req, res) => {
    try {
        const positions = (await getPositions()).sort((a, b) => a.ticker.localeCompare(b.ticker));
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

// Get hold/sell (or hold/cover for shorts) analysis of an open position from its news sentiment (Alpha Vantage + OpenAI APIs)
app.get("/portfolio/:ticker/analysis", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const [position] = await getPositions(ticker);
        if (!position) {
            throw new UpstreamError(`No open position in ${ticker}`, 404);
        }
        const news = await fetchTickerNews(ticker);
        const prompt = position.quantity > 0
            ? `The user owns shares of ${ticker}. Based on the news below, write a brief one-paragraph analysis on whether the user should hold or sell their shares of ${ticker}.`
            : `The user has a short position in ${ticker}. Based on the news below, write a brief one-paragraph analysis on whether the user should keep their short position in ${ticker} open or cover it (buy it back).`;
        const analysis = await analyzeNews(news, prompt);
        res.json({ analysis });
    } catch (error) {
        sendError(res, error);
    }
});


app.listen(5001, () => {
    console.log("server has started on port 5001");
});
