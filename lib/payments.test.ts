import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDollarAmount } from "./payments";

test("parseDollarAmount accepts amounts in whole cents, which floating point can't multiply exactly", () => {
    for (const amount of [0.29, 1.1, 10.03, 0.01, 1, 2500, 49999.99]) assert.equal(parseDollarAmount(amount), amount);
    assert.equal(parseDollarAmount("10.03"), 10.03);
    assert.equal(parseDollarAmount(" 7.5 "), 7.5);
});

test("parseDollarAmount refuses fractions of a cent, zero, negatives and non-numbers", () => {
    for (const value of [0.001, 1.005, 0, -5, NaN, Infinity, "", "abc", null, undefined, {}, "1e400"]) assert.equal(parseDollarAmount(value), null, String(value));
});
