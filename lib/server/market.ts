import "server-only";
import { cachePromise, singleton, type CacheEntry } from "./cache";
import { fetchUsMarketOpen } from "./marketData";
import { marketStatus, type MarketStatus } from "../marketHours";

// For local testing only: MARKET_HOURS_OVERRIDE=open|closed forces the market status
const MARKET_HOURS_OVERRIDE = process.env.MARKET_HOURS_OVERRIDE;

const statusCache = singleton("marketStatusCache", () => new Map<string, CacheEntry<boolean>>());

// The market status from the NYSE calendar (lib/marketHours.ts), also closed when Alpha Vantage reports the U.S. market closed
// during a scheduled session (an unscheduled closure). Alpha Vantage's answer is cached for a minute; if it can't be fetched,
// the calendar decides. Alpha Vantage counts the market open until 4:15 p.m., so it never reopens a session the calendar closed.
export const getMarketStatus = async (): Promise<MarketStatus> => {
    const status = marketStatus();
    if (MARKET_HOURS_OVERRIDE === "open" || MARKET_HOURS_OVERRIDE === "closed") {
        const open = MARKET_HOURS_OVERRIDE === "open";
        return { ...status, open, session: open ? "regular" : "closed", extendedOpen: false, extendedClose: null, nextClose: open ? status.nextClose : null };
    }
    if (!status.open) return status;
    const reportedOpen = await cachePromise(statusCache, "us", 60000, fetchUsMarketOpen).catch(error => {
        console.error(`Market status: ${error.message}; using the NYSE calendar`);
        return true;
    });
    return reportedOpen ? status : { ...status, open: false, session: "closed", extendedOpen: false, extendedClose: null, nextClose: null };
};

export const isMarketOpen = async (): Promise<boolean> => (await getMarketStatus()).open;
