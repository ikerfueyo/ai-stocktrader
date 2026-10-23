import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { baselineDate, forwardReturn, scoreVerdicts, type LoggedVerdict } from "./trackRecord";

// Closes by date for consecutive days, oldest first
const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const series = (closes: number[]) => Object.fromEntries(closes.map((close, i) => [day(i), close]));
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

// 25 sessions: the benchmark flat at 100, UP rising 1 a session from 100, DOWN falling 1 a session from 100
const benchmark = series(Array(25).fill(100));
const closes = { UP: series(Array.from({ length: 25 }, (_, i) => 100 + i)), DOWN: series(Array.from({ length: 25 }, (_, i) => 100 - i)) };
const outcome = (versions: ReturnType<typeof scoreVerdicts>, sessions: number, verdict: string) =>
    versions[0].horizons.find(horizon => horizon.sessions === sessions)!.outcomes.find(outcome => outcome.verdict === verdict)!;

describe("Track record", () => {
    test("forward return over sessions, null without enough of them", () => {
        const dates = Object.keys(closes.UP).sort();
        near(forwardReturn(closes.UP, dates, day(0), 5), 105 / 100 - 1);
        near(forwardReturn(closes.UP, dates, day(19), 5), 124 / 119 - 1);
        assert.equal(forwardReturn(closes.UP, dates, day(20), 5), null);
        assert.equal(forwardReturn(closes.UP, dates, "2025-12-31", 5), null);
    });

    test("a split in between is undone", () => {
        const split = series([100, 100, 50, 50]);
        const dates = Object.keys(split).sort();
        near(forwardReturn(split, dates, day(0), 3, [{ ticker: "X", exDate: day(2), factor: 2 }]), 0);
        // A split on the start date is already in its close
        near(forwardReturn(split, dates, day(2), 1, [{ ticker: "X", exDate: day(2), factor: 2 }]), 0);
    });

    test("hit rates: a buy beats the benchmark, a sell trails it; hold has none", () => {
        const logged: LoggedVerdict[] = [
            { ticker: "UP", verdict: "BUY", priceDate: day(0), promptVersion: 2 },
            { ticker: "DOWN", verdict: "BUY", priceDate: day(0), promptVersion: 2 },
            { ticker: "DOWN", verdict: "SELL", priceDate: day(1), promptVersion: 2 },
            { ticker: "UP", verdict: "HOLD", priceDate: day(2), promptVersion: 2 },
            // Too recent for 20 sessions
            { ticker: "UP", verdict: "BUY", priceDate: day(10), promptVersion: 2 }
        ];
        const versions = scoreVerdicts(logged, closes, benchmark);
        const buy5 = outcome(versions, 5, "BUY");
        assert.equal(buy5.count, 3);
        near(buy5.hitRate, 2 / 3);
        near(buy5.averageReturn, (0.05 - 0.05 + 115 / 110 - 1) / 3);
        near(buy5.averageExcessReturn, buy5.averageReturn!);
        assert.equal(outcome(versions, 20, "BUY").count, 2);
        near(outcome(versions, 5, "SELL").hitRate, 1);
        assert.equal(outcome(versions, 5, "HOLD").hitRate, null);
        assert.equal(versions[0].analyses, 5);
        assert.equal(versions[0].since, day(0));
    });

    test("a verdict made after the newest close it saw is scored from the close of the day it was made", () => {
        const dates = Object.keys(closes.UP).sort();
        assert.equal(baselineDate({ priceDate: day(3) }, dates), day(3));
        assert.equal(baselineDate({ priceDate: day(3), generatedDay: day(3) }, dates), day(3));
        // Saw day 3's close but was made on day 4, with day 4's news: day 3 to day 4's move came before the verdict
        assert.equal(baselineDate({ priceDate: day(3), generatedDay: day(4) }, dates), day(4));
        // Made on a day without a session (a Saturday): the next session
        assert.equal(baselineDate({ priceDate: "2026-10-16", generatedDay: "2026-10-17" }, ["2026-10-15", "2026-10-16", "2026-10-19"]), "2026-10-19");
        assert.equal(baselineDate({ priceDate: day(3), generatedDay: "2027-01-01" }, dates), null);
        const versions = scoreVerdicts([{ ticker: "UP", verdict: "BUY", priceDate: day(0), generatedDay: day(1), promptVersion: 2 }], closes, benchmark);
        near(outcome(versions, 5, "BUY").averageReturn, 106 / 101 - 1);
    });

    test("versions newest first; without the benchmark, returns but no hit rate", () => {
        const logged: LoggedVerdict[] = [
            { ticker: "UP", verdict: "BUY", priceDate: day(0), promptVersion: 2 },
            { ticker: "UP", verdict: "BUY", priceDate: day(0), promptVersion: 3 },
            { ticker: "GONE", verdict: "BUY", priceDate: day(0), promptVersion: 3 }
        ];
        const versions = scoreVerdicts(logged, closes, null);
        assert.deepEqual(versions.map(({ promptVersion }) => promptVersion), [3, 2]);
        const buy = outcome(versions, 5, "BUY");
        assert.equal(buy.count, 1);
        assert.equal(buy.hitRate, null);
        assert.equal(buy.averageExcessReturn, null);
        near(buy.averageReturn, 0.05);
    });
});
