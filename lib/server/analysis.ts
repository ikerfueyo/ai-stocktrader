import "server-only";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { UpstreamError } from "./errors";
import pool from "./db";
import { fetchCompanyOverview, fetchDailyCloses, fetchEarnings, fetchEarningsEstimates, fetchNews, fetchNextReport, fetchTickerNews, MIN_NEWS_RELEVANCE, type NewsItem } from "./alphaVantage";
import { computeTechnicals, type Technicals } from "./technicals";
import { summarizeEarnings, type EarningsSummary } from "./earnings";
import { easternParts, parseEasternTimestamp } from "../marketHours";
import type { AnalysisDetails, AnalysisSource, CompanyOverview, PositionAnalysis, PositionVerdict, Rankings, TickerAnalysis, TickerVerdict } from "../types";

const MODEL = "gpt-6-luna";
// Logged with each verdict (verdict_log), so the track record compares prompts and inputs. Bump it when either changes.
export const PROMPT_VERSION = 2;
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
        model: MODEL,
        // Reasoning off: it didn't change Luna's verdicts on this prompt, and temperature (0 for the JSON calls) is only accepted without it
        reasoning_effort: "none",
        messages: [
            // Price impact rather than tone: positive coverage often follows a move that has already happened
            { role: "system", content: "You are an equity analyst. Your task is to judge how the information given is likely to move a stock's share price over the next few weeks, given what the market already expects and what the price already reflects, not how positive or negative the news sounds. Give more weight to recent information. Provide a response based on the given prompt." },
            { role: "user", content }
        ],
        ...options
    });
    return (response.choices[0].message.content ?? "").trim();
};

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

const analysisCache = singleton("analysisCache", () => new Map<string, CacheEntry<CachedTickerAnalysis>>());

// A ticker's buy/hold/sell verdict and structured analysis, shared by the Trading page and the rankings (which only list tickers
// whose verdict agrees with their side) and the Portfolio page (whose position verdict is derived from it), so they can't contradict
// each other. Cached, with the inputs it was based on, so all of them see the same answer; the rankings extend it.
const ANALYSIS_CACHE_MS = 30 * 60 * 1000;
const VERDICTS: TickerVerdict[] = ["BUY", "HOLD", "SELL"];
const HORIZON = "1 to 4 weeks";
const LIST_ITEMS = 4;

// What an analysis is based on: the ticker's recent news, price and technical figures computed from its daily closes (and SPY's),
// its earnings against estimates and how the estimates are moving, and its valuation and analyst consensus from the company
// overview. All but the news are left out when Alpha Vantage has none.
interface AnalysisInputs {
    news: NewsItem[];
    technicals: Technicals | null;
    earnings: EarningsSummary | null;
    overview: CompanyOverview | null;
    // The inputs as the prompt shows them, articles numbered for citing
    text: string;
}

interface CachedTickerAnalysis extends TickerAnalysis {
    news: NewsItem[];
    inputs: AnalysisInputs;
}

const publishedIso = (published: string) => {
    const date = parseEasternTimestamp(formatPublished(published));
    return Number.isNaN(date.getTime()) ? published : date.toISOString();
};
const percent = (fraction: number | null) => fraction === null ? "n/a" : `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;
const figure = (value: number | null, digits = 2) => value === null ? "n/a" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const eps = (value: number | null) => value === null ? "n/a" : `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const BENCHMARK = "SPY";

const formatEarnings = ({ recent, estimates, next, daysSinceReport }: EarningsSummary) => {
    const lines = ["EARNINGS AND ESTIMATES (earnings per share)"];
    if (next) {
        lines.push(`Next report: ${next.reportDate}${next.timeOfDay ? ` (${next.timeOfDay})` : ""}, in ${next.daysAway} ${next.daysAway === 1 ? "day" : "days"}${next.fiscalDateEnding ? `, for the quarter ending ${next.fiscalDateEnding}` : ""}`);
    }
    if (recent.length > 0) {
        lines.push(`Last report: ${recent[0].reportedDate}, ${daysSinceReport} days ago`);
        lines.push(...recent.map(({ fiscalDateEnding, reportedEps, estimatedEps, surprise }) =>
            `Quarter ending ${fiscalDateEnding}: reported ${eps(reportedEps)} vs estimate ${eps(estimatedEps)} (surprise ${percent(surprise)})`));
    }
    lines.push(...estimates.map(({ fiscalDateEnding, period, average, analysts, change30Days, change90Days, revisionsUp30Days, revisionsDown30Days }) =>
        `Consensus for the fiscal ${period} ending ${fiscalDateEnding}: ${eps(average)}${analysts ? ` (${figure(analysts, 0)} analysts)` : ""}; change in 30 days: ${percent(change30Days)}, in 90 days: ${percent(change90Days)}`
        + (revisionsUp30Days !== null || revisionsDown30Days !== null ? `; revisions in 30 days: ${figure(revisionsUp30Days ?? 0, 0)} up, ${figure(revisionsDown30Days ?? 0, 0)} down` : "")));
    return lines.join("\n");
};

const formatAnalysts = ({ analystTargetPrice, analystRatings }: CompanyOverview, price: number | null) => {
    if (analystTargetPrice === null && analystRatings === null) return null;
    const target = analystTargetPrice === null ? null
        : `target price $${figure(analystTargetPrice)}${price ? ` (${percent(analystTargetPrice / price - 1)} from the last close)` : ""}`;
    const ratings = analystRatings && `ratings: ${analystRatings.strongBuy} strong buy, ${analystRatings.buy} buy, ${analystRatings.hold} hold, ${analystRatings.sell} sell, ${analystRatings.strongSell} strong sell`;
    return `Analyst consensus: ${[target, ratings].filter(Boolean).join("; ")}`;
};

const formatInputs = (ticker: string, news: NewsItem[], technicals: Technicals | null, earnings: EarningsSummary | null, overview: CompanyOverview | null) => {
    const sections = [`NEWS ABOUT ${ticker}, newest first; cite articles by their number\n\n${news.map((item, i) => `[${i + 1}] Published: ${formatPublished(item.published)}\nTitle: ${item.title}\nSummary: ${item.summary}`).join("\n\n")}`];
    if (technicals) {
        sections.push([
            `PRICE AND TECHNICALS (computed from daily closes through ${technicals.asOf})`,
            `Last close: $${figure(technicals.price)}`,
            `Return over 5 sessions: ${percent(technicals.return5d)}; 1 month: ${percent(technicals.return1m)}; 3 months: ${percent(technicals.return3m)}`,
            `Price vs 50-day average: ${percent(technicals.vsSma50)}; vs 200-day average: ${percent(technicals.vsSma200)}`,
            `RSI (14): ${figure(technicals.rsi14, 1)}`,
            ...(technicals.vsBenchmark1m !== null || technicals.vsBenchmark3m !== null
                ? [`Return less ${BENCHMARK}'s: 1 month: ${percent(technicals.vsBenchmark1m)}; 3 months: ${percent(technicals.vsBenchmark3m)}`] : [])
        ].join("\n"));
    }
    if (earnings) {
        sections.push(formatEarnings(earnings));
    }
    if (overview) {
        sections.push([
            `VALUATION AND PROFILE (${overview.name}${overview.sector ? `, ${overview.sector.toLowerCase()}` : ""})`,
            `Market cap: ${overview.marketCap === null ? "n/a" : `$${figure(overview.marketCap / 1e9, 1)}B`}; P/E: ${figure(overview.peRatio)}; forward P/E: ${figure(overview.forwardPe)}`,
            `Dividend yield: ${overview.dividendYield === null ? "n/a" : `${(overview.dividendYield * 100).toFixed(2)}%`}; beta: ${figure(overview.beta)}`,
            `52-week range: $${figure(overview.week52Low)} to $${figure(overview.week52High)}`,
            formatAnalysts(overview, technicals?.price ?? null)
        ].filter(Boolean).join("\n"));
    }
    return sections.join("\n\n---\n\n");
};

const loadInputs = async (ticker: string): Promise<AnalysisInputs> => {
    const news = await fetchTickerNews(ticker);
    // The analysis goes ahead without any of these. SPY's compact series (shared with the performance chart) covers 3 months.
    const [closes, benchmarkCloses, overview, quarters, estimates, nextReport] = await Promise.all([
        fetchDailyCloses(ticker, "full").catch(() => null),
        fetchDailyCloses(BENCHMARK, "compact").catch(() => null),
        fetchCompanyOverview(ticker).catch(() => null),
        fetchEarnings(ticker).catch(() => null),
        fetchEarningsEstimates(ticker).catch(() => null),
        fetchNextReport(ticker).catch(() => null)
    ]);
    const technicals = closes ? computeTechnicals(closes, ticker === BENCHMARK ? null : benchmarkCloses) : null;
    const earnings = summarizeEarnings(quarters, estimates, nextReport, easternParts(new Date()).dateKey);
    return { news, technicals, earnings, overview, text: formatInputs(ticker, news, technicals, earnings, overview) };
};

const ANALYSIS_RULES = `The time horizon is ${HORIZON}. Judge what is likely to move the price, not the tone of the coverage. News is often already reflected in the price, so compare when each article was published with the recent returns, and give little weight to recaps of old news, opinion pieces and lists of stocks. Results against expectations (earnings surprises, changes in analysts' estimates, guidance) matter more than whether the news sounds positive; a reaction to them can continue after the news, so a move that has already happened is a reason neither for nor against on its own. An earnings report within the horizon is a catalyst and a risk. Weigh the news together with the earnings, price, technical and valuation figures. Use only the facts given: never invent figures, confidence percentages, probabilities or price targets. Each list has 2 to ${LIST_ITEMS} short items: "evidence" the facts that support the view, "counterarguments" the strongest facts or readings against it, "risks" what could make it wrong, and "catalysts" upcoming events or developments that could move the price. "sources" lists the numbers of the articles the analysis relies on most; don't put article numbers in the text.`;
const DETAILS_SHAPE = `"evidence": ["..."], "counterarguments": ["..."], "risks": ["..."], "catalysts": ["..."], "sources": [1, 2]`;

// Inline article references such as "[13, 49]", "[29–31]" or "(16)", which mean nothing to the reader (sources lists the
// articles). At most 3 digits, so a year in parentheses stays.
const stripCitations = (text: string) => text.replace(/\s*[[(]\d{1,3}(?:\s*[,–-]\s*\d{1,3})*[\])]/g, "").trim();

const toList = (value: unknown) => (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === "string")
    .map(stripCitations)
    .filter(Boolean)
    .slice(0, LIST_ITEMS);

// The model's lists and citations, checked: only the given articles can be cited (by number), each at most once
const toDetails = (parsed: Record<string, unknown>, inputs: AnalysisInputs): AnalysisDetails => {
    const numbers = [...new Set((Array.isArray(parsed.sources) ? parsed.sources : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= inputs.news.length))];
    const sources: AnalysisSource[] = numbers.slice(0, 6).map(n => {
        const { title, url, published } = inputs.news[n - 1];
        return { title, url, published: publishedIso(published) };
    });
    const dates = [inputs.news[0] && publishedIso(inputs.news[0].published), inputs.technicals && `${inputs.technicals.asOf}T20:00:00.000Z`].filter((date): date is string => Boolean(date)).sort();
    return {
        horizon: HORIZON,
        evidence: toList(parsed.evidence), counterarguments: toList(parsed.counterarguments), risks: toList(parsed.risks), catalysts: toList(parsed.catalysts),
        sources,
        generatedAt: new Date().toISOString(),
        dataAsOf: dates.at(-1) ?? null,
        model: MODEL
    };
};

export const analyzeTicker = (ticker: string) => cachePromise(analysisCache, ticker, ANALYSIS_CACHE_MS, async (): Promise<CachedTickerAnalysis> => {
    const inputs = await loadInputs(ticker);
    const prompt = `Based on the information above, recommend what an investor should do with stock ${ticker} now: buy it, hold off, or sell it (which includes selling it short). The verdict is BUY if the evidence points to the share price rising over the horizon, SELL if it points to the share price falling, and HOLD only if it's genuinely balanced or too thin to call either way. ${ANALYSIS_RULES} "thesis" is a brief one-paragraph explanation of the principal reasons for the verdict, which must agree with it. Respond with JSON only, in the form {"verdict": "BUY" | "HOLD" | "SELL", "thesis": "...", ${DETAILS_SHAPE}}.`;
    const parsed = parseJson(await askAnalyst(`${inputs.text}\n\n${prompt}`, { response_format: { type: "json_object" }, temperature: 0 }));
    const { verdict, thesis } = parsed;
    if (!VERDICTS.includes(verdict as TickerVerdict) || typeof thesis !== "string" || !thesis.trim()) {
        throw new UpstreamError("AI returned an incomplete analysis");
    }
    logVerdict(ticker, verdict as TickerVerdict, inputs.technicals);
    return { verdict: verdict as TickerVerdict, analysis: stripCitations(thesis), ...toDetails(parsed, inputs), news: inputs.news, inputs };
});

// Records each fresh verdict with the newest close it saw, for the track record (GET /api/analysis/track-record). In the background,
// so it never slows or fails the analysis.
const logVerdict = (ticker: string, verdict: TickerVerdict, technicals: Technicals | null) => {
    pool.query(
        "INSERT INTO verdict_log (ticker, verdict, price, price_date, model, prompt_version) VALUES ($1, $2, $3, $4, $5, $6)",
        [ticker, verdict, technicals?.price ?? null, technicals?.asOf ?? null, MODEL, PROMPT_VERSION]
    ).catch(error => console.error(`Logging the ${ticker} verdict: ${error.message}`));
};

// The analysis as the API returns it, without the inputs
export const publicAnalysis = ({ verdict, analysis, horizon, evidence, counterarguments, risks, catalysts, sources, generatedAt, dataAsOf, model }: CachedTickerAnalysis): TickerAnalysis =>
    ({ verdict, analysis, horizon, evidence, counterarguments, risks, catalysts, sources, generatedAt, dataAsOf, model });

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

// The user's position, for the position analysis: its size, cost and P&L, and its weight in the account's equity
export interface PositionContext {
    shares: number;
    avgCost: number;
    price: number | null;
    // As fractions; null without a current price or positive equity
    unrealizedPnlPercent: number | null;
    weight: number | null;
}

// The Portfolio page's hold/sell (or hold/cover) verdict, taken from analyzeTicker, and a structured analysis written for the
// position that explains it, from the same inputs plus the position. Cached per user, ticker, side and verdict, so a refreshed
// ticker analysis with a new verdict gets a new one.
export const analyzePosition = async (userId: string, ticker: string, side: Side, context: PositionContext): Promise<PositionAnalysis> => {
    const { verdict: tickerVerdict, inputs } = await analyzeTicker(ticker);
    const verdict = POSITION_VERDICTS[side][tickerVerdict];
    return cachePromise(positionAnalysisCache, `${userId}:${ticker}:${side}:${verdict}`, ANALYSIS_CACHE_MS, async () => {
        const position = [
            side === "long" ? `The user owns ${figure(context.shares, 6)} shares of ${ticker}` : `The user is short ${figure(context.shares, 6)} shares of ${ticker}`,
            ` at an average ${side === "long" ? "cost" : "sale price"} of $${figure(context.avgCost)}`,
            context.price !== null ? `, now $${figure(context.price)} (${percent(context.unrealizedPnlPercent)} unrealized)` : "",
            context.weight !== null ? `, ${(context.weight * 100).toFixed(1)}% of the account's equity` : "",
            "."
        ].join("");
        const action = POSITION_ACTIONS[side][verdict];
        const prompt = `${position} Based on the information above, the recommendation is that the user should ${action}. ${ANALYSIS_RULES} "thesis" is a brief one-paragraph explanation of why, written for this position (its size and weight in the account may matter), which must agree with that recommendation. Respond with JSON only, in the form {"thesis": "...", ${DETAILS_SHAPE}}.`;
        const parsed = parseJson(await askAnalyst(`${inputs.text}\n\n${prompt}`, { response_format: { type: "json_object" }, temperature: 0 }));
        if (typeof parsed.thesis !== "string" || !parsed.thesis.trim()) {
            throw new UpstreamError("AI returned an incomplete analysis");
        }
        return { verdict, analysis: stripCitations(parsed.thesis), ...toDetails(parsed, inputs) };
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
    const prompt = `The news above is the latest market news, grouped by the stock each article is about, newest first. Pick up to ${RANKING_CANDIDATES} stocks to buy and up to ${RANKING_CANDIDATES} stocks to sell, strongest case first, using only the stock tickers listed. A buy needs news likely to lift the share price over the next few weeks, and a sell news likely to lower it: new information such as results against expectations, guidance, deals, regulatory decisions or analysts' changes, not just a positive or negative tone. Leave out stocks whose news is mixed, neutral, a recap of old news or opinion, and never list a stock on both sides. Respond with JSON only, in the form {"buy": ["TICKER", ...], "sell": ["TICKER", ...]}.`;
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
