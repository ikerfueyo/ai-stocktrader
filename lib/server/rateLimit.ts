import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "./cache";
import { createRateQueue, type Lane } from "./rateQueue";

// The lane the work at hand calls providers in, carried through its async calls: interactive unless it runs in inBackgroundLane
const lanes = singleton("rateLimitLane", () => new AsyncLocalStorage<Lane>());

// Runs fn with its provider calls in the background lane, behind every request a page is waiting on
export const inBackgroundLane = <T>(fn: () => Promise<T>): Promise<T> => lanes.run("background", fn);

// Spaces a provider's requests across every route (lib/server/rateQueue.ts): each starts at least spacingMs after the previous one
// and at most perMinute start in any 61 seconds, interactive requests first. Returns a function that resolves when the caller may
// send its request.
export const rateLimiter = (name: string, spacingMs: number, perMinute: number) => {
    const queue = singleton(`rateQueue:${name}`, () => createRateQueue(spacingMs, perMinute));
    return (): Promise<void> => queue(lanes.getStore() ?? "interactive");
};
