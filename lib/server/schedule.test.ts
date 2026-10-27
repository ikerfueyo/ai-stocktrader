import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isSlotDue } from "./schedule";
import { easternTime } from "../marketHours";

const at = (date: string, time: string) => easternTime(date, time);

describe("isSlotDue", () => {
    const slots = ["04:30", "08:30", "16:30"];

    test("a job that never ran is due at once", () => {
        assert.equal(isSlotDue(slots, null, at("2026-10-21", "10:00")), true);
    });

    test("is due once a slot passes after the last run, and not again until the next", () => {
        assert.equal(isSlotDue(slots, at("2026-10-21", "08:00"), at("2026-10-21", "08:29")), false);
        assert.equal(isSlotDue(slots, at("2026-10-21", "08:00"), at("2026-10-21", "08:30")), true);
        assert.equal(isSlotDue(slots, at("2026-10-21", "08:31"), at("2026-10-21", "16:00")), false);
    });

    test("a slot missed overnight runs when the server is back", () => {
        assert.equal(isSlotDue(slots, at("2026-10-20", "17:00"), at("2026-10-21", "03:00")), false);
        assert.equal(isSlotDue(["23:00"], at("2026-10-20", "17:00"), at("2026-10-21", "03:00")), true);
    });
});
