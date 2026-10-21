import "server-only";

// Next.js can load a module more than once in one process (dev hot reloads, separate route bundles), so state every request must
// share (the caches, the Alpha Vantage rate limit, each user's account lock, the database pool) is created once on globalThis.
// It's still in-process state, so the app assumes a single long-lived server process (next start), not serverless functions.
const store = globalThis as typeof globalThis & { __aiStocktrader?: Map<string, unknown> };

export const singleton = <T>(key: string, create: () => T): T => {
    store.__aiStocktrader ??= new Map();
    if (!store.__aiStocktrader.has(key)) store.__aiStocktrader.set(key, create());
    return store.__aiStocktrader.get(key) as T;
};

export interface CacheEntry<T> {
    promise: Promise<T>;
    expires: number;
}

// Caches a promise per key for ms milliseconds, shared by concurrent callers. Failures aren't kept.
export const cachePromise = <T>(cache: Map<string, CacheEntry<T>>, key: string, ms: number, load: () => Promise<T>): Promise<T> => {
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = load();
    cache.set(key, { promise, expires: Date.now() + ms });
    promise.catch(() => {
        if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
};
