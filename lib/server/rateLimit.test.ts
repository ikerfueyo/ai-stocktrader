import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateQueue, type Clock } from "./rateQueue";

// A clock that only moves when told to, running the timers that come due
const fakeClock = () => {
    let now = 0;
    let timers: { at: number; callback: () => void }[] = [];
    const clock: Clock = { now: () => now, setTimer: (callback, ms) => { timers.push({ at: now + ms, callback }); } };
    const advance = async (ms: number) => {
        const end = now + ms;
        for (;;) {
            const next = timers.filter(({ at }) => at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            timers = timers.filter(timer => timer !== next);
            now = next.at;
            next.callback();
            await Promise.resolve();
        }
        now = end;
        await Promise.resolve();
    };
    return { clock, advance };
};

// Each request records when it was let through
const track = (started: string[], name: string, promise: Promise<void>) => promise.then(() => { started.push(name); });

test("requests start spacingMs apart, in order", async () => {
    const { clock, advance } = fakeClock();
    const wait = createRateQueue(300, 0, clock);
    const started: string[] = [];
    for (const name of ["a", "b", "c"]) track(started, name, wait());
    await advance(0);
    assert.deepEqual(started, ["a"]);
    await advance(299);
    assert.deepEqual(started, ["a"]);
    await advance(1);
    assert.deepEqual(started, ["a", "b"]);
    await advance(300);
    assert.deepEqual(started, ["a", "b", "c"]);
});

test("at most perMinute start in any 61 seconds", async () => {
    const { clock, advance } = fakeClock();
    const wait = createRateQueue(0, 2, clock);
    const started: string[] = [];
    for (const name of ["a", "b", "c"]) track(started, name, wait());
    await advance(0);
    assert.deepEqual(started, ["a", "b"]);
    await advance(60999);
    assert.deepEqual(started, ["a", "b"]);
    await advance(1);
    assert.deepEqual(started, ["a", "b", "c"]);
});

test("interactive requests start before background ones already waiting, each lane in order", async () => {
    const { clock, advance } = fakeClock();
    const wait = createRateQueue(100, 0, clock);
    const started: string[] = [];
    track(started, "bg1", wait("background"));
    track(started, "bg2", wait("background"));
    track(started, "bg3", wait("background"));
    await advance(0);
    track(started, "page1", wait());
    track(started, "page2", wait("interactive"));
    await advance(1000);
    assert.deepEqual(started, ["bg1", "page1", "page2", "bg2", "bg3"]);
});

test("an idle queue lets a request through at once", async () => {
    const { clock, advance } = fakeClock();
    const wait = createRateQueue(300, 150, clock);
    const started: string[] = [];
    track(started, "a", wait());
    await advance(0);
    assert.deepEqual(started, ["a"]);
    await advance(5000);
    track(started, "b", wait("background"));
    await advance(0);
    assert.deepEqual(started, ["a", "b"]);
});
