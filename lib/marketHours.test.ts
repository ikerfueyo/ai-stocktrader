import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { easternTime, isTradingDay, latestTradingDay, marketStatus, nextTradingDay, parseEasternTimestamp, registerCalendar, sessionOn, settlementDate } from "./marketHours";

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

describe("Extended hours", () => {
    test("the pre-market runs from 4:00 a.m. and after-hours until 8:00 p.m.", () => {
        assert.equal(at("2026-10-21", "03:59").session, "closed");
        assert.equal(at("2026-10-21", "03:59").extendedOpen, false);
        assert.equal(at("2026-10-21", "04:00").session, "pre-market");
        assert.equal(at("2026-10-21", "04:00").extendedOpen, true);
        assert.equal(at("2026-10-21", "10:00").extendedOpen, false, "the regular session isn't extended hours");
        assert.equal(at("2026-10-21", "19:59").session, "after-hours");
        assert.equal(at("2026-10-21", "20:00").session, "closed");
        assert.equal(at("2026-10-21", "20:00").extendedOpen, false);
    });

    test("after an early close, after-hours ends at 5:00 p.m.", () => {
        assert.equal(at("2026-11-27", "16:59").session, "after-hours");
        assert.equal(at("2026-11-27", "17:00").session, "closed");
    });

    test("there are no extended sessions on holidays", () => {
        assert.equal(at("2026-12-25", "05:00").extendedOpen, false);
    });
});

describe("Alpaca's registered calendar", () => {
    const day = (date: string, close = "16:00") => ({ date, open: "09:30", close, sessionOpen: "0400", sessionClose: close === "16:00" ? "2000" : "1700", settlementDate: "" });

    test("takes precedence over the lists for the dates it covers", () => {
        // Covers 2030-10-21 (a Monday) to 2030-10-23, with the 22nd closed (an unscheduled closure) and the 23rd closing early
        registerCalendar({
            days: [{ ...day("2030-10-21"), settlementDate: "2030-10-23" }, { ...day("2030-10-23", "13:00"), settlementDate: "2030-10-24" }],
            from: "2030-10-21", to: "2030-10-23"
        });
        try {
            assert.equal(isTradingDay("2030-10-21"), true);
            assert.equal(isTradingDay("2030-10-22"), false, "missing from the calendar, so closed");
            assert.equal(sessionOn("2030-10-23")!.earlyClose, true);
            assert.equal(at("2030-10-23", "16:30").session, "after-hours");
            assert.equal(at("2030-10-23", "17:00").session, "closed");
            assert.equal(at("2030-10-21", "10:00").calendarKnown, true);
            assert.equal(settlementDate("2030-10-21"), "2030-10-23", "its settlement date skips the closure");
            assert.equal(isTradingDay("2030-10-24"), true, "outside the calendar, weekdays are trading days");
        } finally {
            registerCalendar(null);
        }
    });

    test("trades settle the next trading day without it", () => {
        assert.equal(settlementDate("2026-10-23"), "2026-10-26", "Friday to Monday");
        assert.equal(settlementDate("2026-11-25"), "2026-11-27", "over Thanksgiving");
    });
});
