import "server-only";
import { fetchOptionChainRows, fetchQuote, isStaleQuote, optionChainOverridden, registerOptionQuotes, type OptionChainRow } from "../alphaVantage";
import { ALPACA_OPTIONS_FEED, fetchOptionSnapshots, isAlpacaConfigured, type AlpacaOptionSnapshot } from "./alpaca";
import { UpstreamError } from "../httpError";
import { medianVolatility, modelOptionQuote, usableVolatility, type ChainContract, type OptionQuoteModel } from "../broker/sim/options";
import { optionSymbol, parseOptionSymbol } from "../../options";
import { easternParts } from "../../marketHours";
import type { Quote } from "../../types";

// Option chains and contract quotes. Alpha Vantage's REALTIME_OPTIONS when the plan includes it (quoted as they are); otherwise the last
// session's closing chain (HISTORICAL_OPTIONS) lists the contracts, and each is quoted from Alpaca's option snapshots when Alpaca's keys
// are set (ALPACA_OPTIONS_FEED: indicative, the free feed, or opra), else, or without a current quote there, modeled now from the
// underlying's realtime price (modelOptionQuote: the closing mark moved by Black-Scholes at the contract's implied volatility, the closing
// spread around it). Option quotes reach the rest of the app through fetchQuotes (registered below), so orders, valuations and margin
// price contracts like stocks.

export type OptionQuoteSource = "realtime" | "indicative" | "modeled";

export interface ChainEntry extends ChainContract {
    quote: OptionQuoteModel;
    quoteSource: OptionQuoteSource;
    // When Alpaca quoted it; null for a quote timed like the underlying's (modeled, or Alpha Vantage's realtime chain)
    quoteTime: string | null;
}

export interface OptionChain {
    underlying: Quote;
    // realtime or indicative when any contract is quoted so, else modeled
    source: OptionQuoteSource;
    // The session the chain's closing prices are from (modeled quotes), or the newest quote's time
    asOf: string;
    contracts: ChainEntry[];
}

const num = (value: string | undefined): number | null => {
    const parsed = parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : null;
};
const positive = (value: string | undefined) => {
    const parsed = num(value);
    return parsed !== null && parsed > 0 ? parsed : null;
};

const toContract = (row: OptionChainRow, underlying: string): ChainContract | null => {
    const strike = num(row.strike);
    if (strike === null || !(row.type === "call" || row.type === "put") || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiration)) return null;
    const contract = { underlying, expiration: row.expiration, type: row.type, strike };
    return {
        ...contract, symbol: optionSymbol(contract), date: row.date,
        last: positive(row.last), mark: num(row.mark), bid: num(row.bid), ask: positive(row.ask), bidSize: num(row.bid_size), askSize: num(row.ask_size),
        volume: num(row.volume), openInterest: num(row.open_interest), impliedVolatility: num(row.implied_volatility)
    };
};

// The underlying's close on the chain's session: its current price once that session is the quote's own (after its close), else the
// previous close
const closeOn = (quote: Quote, day: string) => easternParts(new Date(quote.quoteTime)).dateKey === day ? quote.price : quote.previousClose ?? quote.price;

// A contract's quote from its Alpaca snapshot: a current bid and ask (not stale during a session, isStaleQuote), its implied volatility
// and Greeks where Alpaca has them, else the model's. Null when there's no such quote, so the contract is modeled.
const snapshotQuote = (snapshot: AlpacaOptionSnapshot | undefined, modeled: OptionQuoteModel, now: Date): { quote: OptionQuoteModel; time: string } | null => {
    const latest = snapshot?.latestQuote;
    if (!latest || !(latest.ap > 0) || !(latest.bp >= 0) || latest.ap < latest.bp) return null;
    if (isStaleQuote({ quoteTime: latest.t, delay: "realtime" }, now)) return null;
    const greeks = snapshot.greeks;
    return {
        quote: {
            price: (latest.bp + latest.ap) / 2, bid: latest.bp, ask: latest.ap,
            impliedVolatility: usableVolatility(snapshot.impliedVolatility ?? null) ?? modeled.impliedVolatility,
            delta: greeks?.delta ?? modeled.delta, gamma: greeks?.gamma ?? modeled.gamma, theta: greeks?.theta ?? modeled.theta, vega: greeks?.vega ?? modeled.vega
        },
        time: latest.t
    };
};

// An underlying's whole chain, each contract with its quote and Greeks now, expirations and strikes in order
export const fetchOptionChain = async (underlying: string, now = new Date()): Promise<OptionChain> => {
    const symbol = underlying.toUpperCase();
    // A failure at Alpaca leaves the chain modeled rather than failing it
    const snapshotsFetched = isAlpacaConfigured() && !optionChainOverridden(symbol)
        ? fetchOptionSnapshots(symbol).catch(error => {
            console.warn(`Alpaca option snapshots for ${symbol}: ${error instanceof Error ? error.message : error}`);
            return null;
        })
        : Promise.resolve(null);
    const [{ rows, realtime }, quote, fetchedSnapshots] = await Promise.all([fetchOptionChainRows(symbol), fetchQuote(symbol), snapshotsFetched]);
    const snapshots = realtime ? null : fetchedSnapshots;
    const alpacaSource: OptionQuoteSource = ALPACA_OPTIONS_FEED === "opra" ? "realtime" : "indicative";
    const today = easternParts(now).dateKey;
    const contracts = rows.map(row => toContract(row, symbol)).filter((contract): contract is ChainContract => contract !== null && contract.expiration >= today);
    if (contracts.length === 0) throw new UpstreamError(`No listed options for ${symbol}`, 404);
    const fallback = new Map<string, number>();
    for (const expiration of new Set(contracts.map(({ expiration }) => expiration))) {
        fallback.set(expiration, medianVolatility(contracts.filter(contract => contract.expiration === expiration)));
    }
    const entries = contracts.map((contract, index): ChainEntry => {
        if (realtime) {
            const row = rows.find(candidate => candidate.contractID === contract.symbol || (candidate.expiration === contract.expiration && Number(candidate.strike) === contract.strike && candidate.type === contract.type)) ?? rows[index];
            const bid = contract.bid ?? 0;
            const ask = contract.ask ?? bid;
            return {
                ...contract, quote: {
                    price: contract.mark ?? (bid + ask) / 2, bid, ask, impliedVolatility: contract.impliedVolatility ?? fallback.get(contract.expiration)!,
                    delta: num(row.delta) ?? 0, gamma: num(row.gamma) ?? 0, theta: num(row.theta) ?? 0, vega: num(row.vega) ?? 0
                },
                quoteSource: "realtime", quoteTime: null
            };
        }
        const modeled = modelOptionQuote(contract, { underlying: quote.price, underlyingAtClose: closeOn(quote, contract.date), now, fallbackVolatility: fallback.get(contract.expiration)! });
        const quoted = snapshots ? snapshotQuote(snapshots.get(contract.symbol), modeled, now) : null;
        return quoted
            ? { ...contract, quote: quoted.quote, quoteSource: alpacaSource, quoteTime: quoted.time }
            : { ...contract, quote: modeled, quoteSource: "modeled", quoteTime: null };
    });
    entries.sort((a, b) => a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.type.localeCompare(b.type));
    if (realtime) return { underlying: quote, source: "realtime", asOf: quote.quoteTime, contracts: entries };
    const quoteTimes = entries.flatMap(({ quoteTime }) => quoteTime ? [quoteTime] : []).sort();
    return quoteTimes.length > 0
        ? { underlying: quote, source: alpacaSource, asOf: quoteTimes[quoteTimes.length - 1], contracts: entries }
        : { underlying: quote, source: "modeled", asOf: contracts[0].date, contracts: entries };
};

// One listed contract of the chain with its quote now, or null when the chain doesn't list it (or it has expired)
export const fetchOptionContract = async (symbol: string, now = new Date()): Promise<{ contract: ChainEntry; chain: OptionChain } | null> => {
    const id = parseOptionSymbol(symbol);
    if (!id) return null;
    const chain = await fetchOptionChain(id.underlying, now).catch(error => {
        if (error instanceof UpstreamError && error.status === 404) return null;
        throw error;
    });
    const contract = chain?.contracts.find(entry => entry.symbol === symbol.toUpperCase());
    return contract && chain ? { contract, chain } : null;
};

// A contract's quote in the app's Quote shape: its mark as the price and its bid/ask. Alpaca's quotes keep their own time; modeled ones
// (and Alpha Vantage's realtime ones) are timed like the underlying's quote, so they're stale exactly when the underlying's is. The
// previous close is the chain's closing mark.
const fetchOptionQuote = async (symbol: string): Promise<Quote> => {
    const found = await fetchOptionContract(symbol);
    if (!found) throw new UpstreamError(`${symbol} isn't a listed option contract`, 404);
    const { contract, chain } = found;
    return {
        ticker: contract.symbol, price: contract.quote.price, previousClose: contract.mark, bid: contract.quote.bid, ask: contract.quote.ask,
        spread: contract.quoteSource === "modeled" ? "simulated" : "quoted",
        quoteTime: contract.quoteTime ?? chain.underlying.quoteTime, delay: contract.quoteTime ? "realtime" : chain.underlying.delay,
        open: null, high: null, low: null, volume: null, extendedHoursPrice: null
    };
};

registerOptionQuotes(fetchOptionQuote);
