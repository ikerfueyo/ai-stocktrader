import "server-only";
import { singleton } from "./cache";

// Spaces a provider's requests across every route: each starts at least spacingMs after the previous one and at most perMinute
// start in any 61 seconds (a second's margin, since providers count requests as they arrive). Each caller reserves the next free
// slot synchronously, so parallel calls queue up in order. Returns a function that resolves when the caller may send its request.
export const rateLimiter = (name: string, spacingMs: number, perMinute: number) => {
    const windowMs = 61000;
    const slots = singleton(`rateLimit:${name}`, () => ({ starts: [] as number[] }));
    return (): Promise<void> => {
        const now = Date.now();
        const { starts } = slots;
        while (starts.length > 0 && starts[0] <= now - windowMs) starts.shift();
        const last = starts.at(-1);
        const windowFull = perMinute > 0 && starts.length >= perMinute;
        const start = Math.max(
            now,
            last === undefined ? now : last + spacingMs,
            windowFull ? starts[starts.length - perMinute] + windowMs : now
        );
        starts.push(start);
        return new Promise(resolve => setTimeout(resolve, start - now));
    };
};
