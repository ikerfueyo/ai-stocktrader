// The scheduling behind rateLimiter (lib/server/rateLimit.ts), kept free of server-only so it can be unit tested. Requests start at
// least spacingMs apart and at most perMinute in any 61 seconds (a second's margin, since providers count requests as they arrive).
// Waiting requests start in order within a lane, and every interactive request (one a page waits on: quotes, search, a ticker's
// page) before any background one (the rankings rebuild, the corporate actions and universe jobs), so a long run of background
// calls doesn't hold up the pages.

export type Lane = "interactive" | "background";

export interface Clock {
    now: () => number;
    setTimer: (callback: () => void, ms: number) => void;
}

const realClock: Clock = {
    now: () => Date.now(),
    setTimer: (callback, ms) => {
        setTimeout(callback, ms);
    }
};

const WINDOW_MS = 61000;

// Returns a function that resolves when the caller may send its request
export const createRateQueue = (spacingMs: number, perMinute: number, clock: Clock = realClock) => {
    const starts: number[] = [];
    const waiting: Record<Lane, (() => void)[]> = { interactive: [], background: [] };
    let timerSet = false;

    const pump = () => {
        timerSet = false;
        for (;;) {
            const lane = waiting.interactive.length > 0 ? waiting.interactive : waiting.background.length > 0 ? waiting.background : null;
            if (!lane) return;
            const now = clock.now();
            while (starts.length > 0 && starts[0] <= now - WINDOW_MS) starts.shift();
            const last = starts.at(-1);
            const earliest = Math.max(
                now,
                last === undefined ? now : last + spacingMs,
                perMinute > 0 && starts.length >= perMinute ? starts[starts.length - perMinute] + WINDOW_MS : now
            );
            if (earliest > now) {
                timerSet = true;
                clock.setTimer(pump, earliest - now);
                return;
            }
            starts.push(now);
            lane.shift()!();
        }
    };

    return (lane: Lane = "interactive"): Promise<void> => new Promise(resolve => {
        waiting[lane].push(resolve);
        if (!timerSet) pump();
    });
};
