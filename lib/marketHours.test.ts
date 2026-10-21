import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { easternTime, isTradingDay, latestTradingDay, marketStatus, nextTradingDay, parseEasternTimestamp } from "./marketHours";

const at = (dateKey: string, time: string) => marketStatus(easternTime(dateKey, time));

describe("Eastern time conversion", () => {
    test("uses EDT in summer and EST in winter", () => {
        assert.equal(easternTime("2026-07-15", "09:30").toISOString(), "2026-07-15T13:30:00.000Z");
        assert.equal(easternTime("2026-01-15", "09:30").toISOString(), "2026-01-15T14:30:00.000Z");
    });

    test("handles the days of the daylight-saving switches", () => {
        // DST starts Sunday March 8, 2026 and ends Sunday November 1, 2026
        assert.equal(easternTime("2026-03-09", "09:30").toISOString(), "2026-03-09T13:30:00.000Z");
        assert.equal(easternTime("2026-03-06", "16:00").toISOString(), "2026-03-06T21:00:00.000Z");
        assert.equal(easternTime("2026-11-02", "09:30").toISOString(), "2026-11-02T14:30:00.000Z");
    });

    test("parses Alpha Vantage's Eastern quote timestamps", () => {
        assert.equal(parseEasternTimestamp("2026-10-21 15:59:55.291").toISOString(), "2026-10-21T19:59:55.291Z");
    });
});

describe("Trading days", () => {
    test("weekends and NYSE holidays aren't trading days", () => {
        assert.equal(isTradingDay("2026-10-24"), false, "Saturday");
        assert.equal(isTradingDay("2026-10-25"), false, "Sunday");
        assert.equal(isTradingDay("2026-11-26"), false, "Thanksgiving");
        assert.equal(isTradingDay("2026-07-03"), false, "Independence Day observed");
        assert.equal(isTradingDay("2026-10-21"), true);
    });

    test("next and latest trading days skip weekends and holidays", () => {
        assert.equal(nextTradingDay("2026-10-23"), "2026-10-26", "Friday to Monday");
        assert.equal(nextTradingDay("2026-11-25"), "2026-11-27", "over Thanksgiving");
        assert.equal(nextTradingDay("2026-12-31"), "2027-01-04", "over New Year's Day and a weekend");
        assert.equal(latestTradingDay("2026-10-25"), "2026-10-23");
    });
});

describe("marketStatus", () => {
    test("is open during the regular session, with today's close", () => {
        const status = at("2026-10-21", "10:00");
        assert.equal(status.open, true);
        assert.equal(status.session, "regular");
        assert.equal(status.nextClose, "2026-10-21T20:00:00.000Z");
        assert.equal(status.nextOpen, "2026-10-22T13:30:00.000Z");
    });

    test("is closed before the open and after the close", () => {
        const before = at("2026-10-21", "09:29");
        assert.equal(before.open, false);
        assert.equal(before.session, "pre-market");
        assert.equal(before.nextOpen, "2026-10-21T13:30:00.000Z");
        const after = at("2026-10-21", "16:00");
        assert.equal(after.open, false);
        assert.equal(after.session, "after-hours");
        assert.equal(after.nextOpen, "2026-10-22T13:30:00.000Z");
    });

    test("on a weekend, the next open is Monday", () => {
        const status = at("2026-10-24", "12:00");
        assert.equal(status.session, "closed");
        assert.equal(status.nextOpen, "2026-10-26T13:30:00.000Z");
    });

    test("closes at 1:00 p.m. on early-close days", () => {
        assert.equal(at("2026-11-27", "12:59").open, true);
        assert.equal(at("2026-11-27", "12:59").earlyClose, true);
        assert.equal(at("2026-11-27", "13:00").open, false);
    });

    test("is closed all day on a holiday", () => {
        assert.equal(at("2026-12-25", "11:00").open, false);
        assert.equal(at("2026-12-25", "11:00").nextOpen, "2026-12-28T14:30:00.000Z");
    });

    test("reports whether the year's holidays are known", () => {
        assert.equal(at("2026-10-21", "10:00").calendarKnown, true);
        assert.equal(at("2030-10-21", "10:00").calendarKnown, false);
    });
});
