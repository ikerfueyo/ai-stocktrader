import "server-only";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { UpstreamError } from "./errors";
import { fetchNews, fetchTickerNews, MIN_NEWS_RELEVANCE, type NewsItem } from "./alphaVantage";
import type { PositionAnalysis, PositionVerdict, Rankings, TickerVerdict } from "../types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });

// The companies an article is mainly about: its most relevant tickers. Analyst notes also tag the bank that wrote them
// ("JPMorgan cuts target for Bunge" is BG 1.0, JPM 0.63), which this leaves out.
const mainTickers = (item: NewsItem) => {
    const top = Math.max(...item.tickers.map(({ relevance }) => relevance));
    return item.tickers.filter(({ relevance }) => relevance >= Math.max(MIN_NEWS_RELEVANCE, top - 0.1));
};

// "20261020T223723" -> "2026-10-20 22:37"
const formatPublished = (published = "") => published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}).*$/, "$1-$2-$3 $4:$5");

const formatNews = (news: NewsItem[]) => news.map(item => `Published: ${formatPublished(item.published)}\nTitle: ${item.title}\nSummary: ${item.summary}`).join("\n\n");

type AnalystOptions = Pick<ChatCompletionCreateParamsNonStreaming, "response_format" | "temperature">;

const askAnalyst = async (content: string, options: AnalystOptions = {}) => {
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
    return (response.choices[0].message.content ?? "").trim();
};

const analyzeNews = (news: NewsItem[], prompt: string, options?: AnalystOptions) => askAnalyst(`${formatNews(news)}\n\n${prompt}`, options);

const parseJson = (content: string): Record<string, unknown> => {
    try {
        return JSON.parse(content);
    } catch {
        throw new UpstreamError("AI returned invalid JSON");
    }
};

const toTickers = (list: unknown, limit: number) => (Array.isArray(list) ? list : [])
    .filter((ticker): ticker is string => typeof ticker === "string")
    .map(ticker => ticker.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, limit);

// A ticker's buy/hold/sell verdict and analysis, shared by the Trading page and the rankings (which only list tickers whose verdict
// agrees with their side) and the Portfolio page (whose position verdict is derived from it), so they can't contradict each other.
// Cached, with the news it was based on, so all of them see the same answer; the rankings extend it.
const ANALYSIS_CACHE_MS = 30 * 60 * 1000;
const VERDICTS: TickerVerdict[] = ["BUY", "HOLD", "SELL"];

interface TickerAnalysisWithNews {
    verdict: TickerVerdict;
    analysis: string;
    news: NewsItem[];
}

const analysisCache = singleton("analysisCache", () => new Map<string, CacheEntry<TickerAnalysisWithNews>>());

export const analyzeTicker = (ticker: string) => cachePromise(analysisCache, ticker, ANALYSIS_CACHE_MS, async () => {
    const news = await fetchTickerNews(ticker);
    const prompt = `Based on the news below, recommend what an investor should do with stock ${ticker} now: buy it, hold off, or sell it (which includes selling it short). Respond with JSON only, in the form {"verdict": "BUY" | "HOLD" | "SELL", "analysis": "..."}. The verdict is BUY if the news points to the share price rising, SELL if it points to the share price falling, and HOLD only if the news is genuinely balanced or too thin to call either way. The analysis is a brief one-paragraph explanation that must agree with the verdict.`;
    const { verdict, analysis } = parseJson(await analyzeNews(news, prompt, { response_format: { type: "json_object" }, temperature: 0 }));
    if (!VERDICTS.includes(verdict as TickerVerdict) || typeof analysis !== "string" || !analysis.trim()) {
        throw new UpstreamError("AI returned an incomplete analysis");
    }
    return { verdict: verdict as TickerVerdict, analysis: analysis.trim(), news };
});

// A ticker's verdict if its analysis is already cached and finished, without fetching anything (for the watchlist, so listing
// tickers never costs Alpha Vantage or OpenAI calls); null otherwise
export const peekTickerVerdict = async (ticker: string): Promise<TickerVerdict | null> => {
    const cached = analysisCache.get(ticker);
    if (!cached || cached.expires <= Date.now()) return null;
    // A promise that's still pending (or failed) counts as not cached. The timeout runs after the settled promise's callbacks.
    const pending = new Promise<null>(resolve => setTimeout(() => resolve(null), 0));
    return Promise.race([cached.promise.then(({ verdict }) => verdict, () => null), pending]);
};

// What a ticker's verdict means for an open position: a long is sold on SELL and held otherwise (there's no buying more from the
// Portfolio page), and a short is covered on BUY and kept open otherwise
type Side = "long" | "short";
const POSITION_VERDICTS: Record<Side, Record<TickerVerdict, PositionVerdict>> = {
    long: { BUY: "HOLD", HOLD: "HOLD", SELL: "SELL" },
    short: { BUY: "COVER", HOLD: "HOLD", SELL: "HOLD" }
};
const POSITION_ACTIONS: Record<Side, Partial<Record<PositionVerdict, string>>> = {
    long: { HOLD: "hold their shares", SELL: "sell their shares" },
    short: { HOLD: "keep their short position open", COVER: "cover their short position (buy the shares back)" }
};
const positionAnalysisCache = singleton("positionAnalysisCache", () => new Map<string, CacheEntry<PositionAnalysis>>());

// The Portfolio page's hold/sell (or hold/cover) verdict, taken from analyzeTicker, and a paragraph written for the position that
// explains it. Cached by verdict too, so a refreshed ticker analysis with a new verdict gets a new paragraph.
export const analyzePosition = async (ticker: string, side: Side) => {
    const { verdict: tickerVerdict, news } = await analyzeTicker(ticker);
    const verdict = POSITION_VERDICTS[side][tickerVerdict];
    return cachePromise(positionAnalysisCache, `${ticker}:${side}:${verdict}`, ANALYSIS_CACHE_MS, async () => {
        const position = side === "long" ? `The user owns shares of ${ticker}.` : `The user has a short position in ${ticker}.`;
        const action = POSITION_ACTIONS[side][verdict];
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
const rankingsCache = singleton("rankingsCache", () => new Map<string, CacheEntry<Rankings>>());

interface StockNews {
    ticker: string;
    articles: NewsItem[];
    sentimentSum: number;
}

// Checks candidates in order, a couple more than still needed at a time, since some won't be confirmed
const confirmRankings = async (candidates: string[], verdict: TickerVerdict) => {
    const picks: string[] = [];
    const errors: unknown[] = [];
    const checked: string[] = [];
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

const buildRankings = async (): Promise<Rankings> => {
    const news = await fetchNews({ limit: 1000 });
    // Skips crypto and forex symbols (CRYPTO:BTC, FOREX:USD), preferred shares (ARR-P-C), and Nasdaq symbols whose 5th letter marks
    // a preferred share, warrant, unit or right (BWBBP)
    const newsByTicker = new Map<string, StockNews>();
    for (const item of news) {
        for (const { ticker, sentiment } of mainTickers(item).filter(({ ticker }) => /^([A-Z]{1,4}|[A-Z]{4}[A-OQSTVX-Z])(-[A-Z])?$/.test(ticker))) {
            const stock = newsByTicker.get(ticker) ?? { ticker, articles: [], sentimentSum: 0 };
            stock.articles.push(item);
            stock.sentimentSum += sentiment;
            newsByTicker.set(ticker, stock);
        }
    }
    // Strength grows with the average sentiment and, more slowly, with the number of articles agreeing with it
    const stockStrength = ({ articles, sentimentSum }: StockNews) => sentimentSum / Math.sqrt(articles.length);
    const averageSentiment = ({ articles, sentimentSum }: StockNews) => sentimentSum / articles.length;
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
    const toCandidates = (tickers: string[], other: string[]) => tickers.filter(ticker => !other.includes(ticker)).map(ticker => ticker.replaceAll("-", "."));
    const buyCandidates = toCandidates(buy, sell);
    const sellCandidates = toCandidates(sell, buy);
    if (buyCandidates.length === 0 && sellCandidates.length === 0) {
        throw new UpstreamError("AI returned no rankings");
    }

    const [confirmedBuys, confirmedSells] = await Promise.all([confirmRankings(buyCandidates, "BUY"), confirmRankings(sellCandidates, "SELL")]);
    console.log(`GET /api/rankings: ${news.length} articles on ${newsByTicker.size} stocks; sent ${bullish.length} bullish and ${bearish.length} bearish stocks to the AI; `
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

// Up to 5 buy and 5 sell stocks, cached for 30 minutes
export const getRankings = () => cachePromise(rankingsCache, "rankings", RANKINGS_CACHE_MS, buildRankings);
