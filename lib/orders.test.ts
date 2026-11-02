import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toOrder } from "./orders";

describe("toOrder", () => {
    test("a dollar amount buys whole millionths of a share, and the total is what they cost", () => {
        assert.deepEqual(toOrder({ mode: "dollars", value: 100, price: 30 }), { quantity: 3.333333, total: 100 });
        assert.deepEqual(toOrder({ mode: "dollars", value: 0.3, price: 0.1 }), { quantity: 3, total: 0.3 });
    });

    test("rounding a dollar amount never buys shares worth more than was paid", () => {
        // $0.36 at $700,000 a share is half a millionth of a share, which used to round up to a millionth worth $0.70
        assert.deepEqual(toOrder({ mode: "dollars", value: 0.36, price: 700000 }), { quantity: 0, total: 0 });
        const { quantity, total } = toOrder({ mode: "dollars", value: 1.5, price: 700000 });
        assert.equal(quantity, 0.000002);
        assert.equal(total, 1.4);
    });

    test("an order worth less than a cent is empty", () => {
        assert.deepEqual(toOrder({ mode: "shares", value: 0.000001, price: 1 }), { quantity: 0, total: 0 });
        assert.deepEqual(toOrder({ mode: "shares", value: 0.004, price: 1 }), { quantity: 0, total: 0 });
        assert.deepEqual(toOrder({ mode: "shares", value: 0.01, price: 1 }), { quantity: 0.01, total: 0.01 });
    });

    test("a dollar amount that covers the whole position closes it exactly", () => {
        assert.deepEqual(toOrder({ mode: "dollars", value: 500, price: 30, maxShares: 10 }), { quantity: 10, total: 300 });
        assert.deepEqual(toOrder({ mode: "shares", value: 12, price: 30, maxShares: 10 }), { quantity: 10, total: 300 });
    });

    test("no price or no amount is an empty order", () => {
        assert.deepEqual(toOrder({ mode: "shares", value: 5, price: null }), { quantity: 0, total: 0 });
        assert.deepEqual(toOrder({ mode: "dollars", value: 0, price: 10 }), { quantity: 0, total: 0 });
    });
});
