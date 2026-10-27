import "server-only";
import axios, { isAxiosError } from "axios";
import { cachePromise, singleton, type CacheEntry } from "../cache";
import { UpstreamError } from "../errors";
import { rateLimiter } from "../rateLimit";
import type { components as Trading } from "./generated/tradingApi";
import type { components as MarketData } from "./generated/marketDataApi";
import type { QuoteBook } from "../../types";

// Alpaca's free market data (a Trading API account's keys, used for data only: no orders, no money) for what Alpha Vantage
// doesn't have: the asset list with its trading flags, the market calendar and clock, and the top of book with sizes. Without
// ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY these all report that Alpaca isn't configured, and callers fall back.
// ALPACA_TRADING_URL is the paper API unless set (a free account's keys are paper keys). ALPACA_DATA_FEED is iex on the free
// Basic plan, sip with Algo Trader Plus.
const KEY_ID = process.env.ALPACA_API_KEY_ID;
const SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
const TRADING_URL = process.env.ALPACA_TRADING_URL ?? "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";
export const ALPACA_DATA_FEED: QuoteBook["feed"] = process.env.ALPACA_DATA_FEED === "sip" ? "sip" : "iex";

export type AlpacaAsset = Trading["schemas"]["Assets"];
export type AlpacaCalendarDay = Trading["schemas"]["legacy_calendar_day"];
export type AlpacaClock = Trading["schemas"]["legacy_clock"];
type Snapshot = MarketData["schemas"]["stock_snapshot"];

export const isAlpacaConfigured = (): boolean => Boolean(KEY_ID && SECRET_KEY);

// The Basic plan allows 200 calls a minute (ALPACA_REQUESTS_PER_MINUTE to change it, such as 10000 with Algo Trader Plus), with
// requests started at least 100ms apart
const waitForAlpacaSlot = rateLimiter("alpaca", 100, Number(process.env.ALPACA_REQUESTS_PER_MINUTE ?? 190));

export class AlpacaNotConfiguredError extends UpstreamError {
    constructor() {
        super("Alpaca market data isn't configured (set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY)", 503);
    }
}

const fetchAlpaca = async <T>(api: "trading" | "data", path: string, params: Record<string, string | number | boolean> = {}): Promise<T> => {
    if (!isAlpacaConfigured()) throw new AlpacaNotConfiguredError();
    await waitForAlpacaSlot();
    try {
        const response = await axios.get<T>(`${api === "trading" ? TRADING_URL : DATA_URL}${path}`, {
            params,
            headers: { "APCA-API-KEY-ID": KEY_ID, "APCA-API-SECRET-KEY": SECRET_KEY },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        if (isAxiosError(error) && error.response) {
            const body = error.response.data as { message?: string } | undefined;
            throw new UpstreamError(`Alpaca ${path}: ${error.response.status} ${body?.message ?? error.message}`);
        }
        throw error;
    }
};

// Every active U.S. equity Alpaca lists (about 12,000, including ETFs and OTC listings), refreshed at most every 8 hours since
// Alpaca updates its flags 3 times a day
const assetsCache = singleton("alpacaAssetsCache", () => new Map<string, CacheEntry<AlpacaAsset[]>>());
export const fetchAlpacaAssets = () => cachePromise(assetsCache, "us_equity", 8 * 3600000, () =>
    fetchAlpaca<AlpacaAsset[]>("trading", "/v2/assets", { status: "active", asset_class: "us_equity" }));

// The trading days from start to end ("YYYY-MM-DD"), with their regular and extended session times and settlement dates
const calendarCache = singleton("alpacaCalendarCache", () => new Map<string, CacheEntry<AlpacaCalendarDay[]>>());
export const fetchAlpacaCalendar = (start: string, end: string) => cachePromise(calendarCache, `${start}|${end}`, 24 * 3600000, () =>
    fetchAlpaca<AlpacaCalendarDay[]>("trading", "/v2/calendar", { start, end }));

const clockCache = singleton("alpacaClockCache", () => new Map<string, CacheEntry<AlpacaClock>>());
export const fetchAlpacaClock = () => cachePromise(clockCache, "clock", 60000, () => fetchAlpaca<AlpacaClock>("trading", "/v2/clock"));

// The top of book for each ticker (one call for all of them), cached 15s like Alpha Vantage's quotes. A ticker without an active
// bid and ask on the feed (common on IEX for thinly traded stocks) gets null.
const bookCache = singleton("alpacaBookCache", () => new Map<string, CacheEntry<QuoteBook | null>>());
const toBook = (snapshot: Snapshot | undefined): QuoteBook | null => {
    const quote = snapshot?.latestQuote;
    if (!quote || !(quote.bp > 0) || !(quote.ap >= quote.bp)) return null;
    return {
        feed: ALPACA_DATA_FEED,
        bid: quote.bp, bidSize: quote.bs, ask: quote.ap, askSize: quote.as,
        lastPrice: snapshot?.latestTrade?.p ?? null,
        lastSize: snapshot?.latestTrade?.s ?? null,
        time: quote.t
    };
};
export const fetchQuoteBooks = (tickers: string[]): Promise<QuoteBook | null>[] => {
    const symbols = tickers.map(ticker => ticker.toUpperCase());
    const missing = [...new Set(symbols)].filter(symbol => !((bookCache.get(symbol)?.expires ?? 0) > Date.now()));
    const snapshots = missing.length > 0
        ? fetchAlpaca<Record<string, Snapshot>>("data", "/v2/stocks/snapshots", { symbols: missing.join(","), feed: ALPACA_DATA_FEED })
        : Promise.resolve({} as Record<string, Snapshot>);
    // Each caller gets the failure through its own promise; this keeps a reply nobody ends up waiting on from going unhandled
    snapshots.catch(() => {});
    return symbols.map(symbol => cachePromise(bookCache, symbol, 15000, async () => toBook((await snapshots)[symbol])));
};
