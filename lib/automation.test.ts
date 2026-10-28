import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alertFires, followingDate, nextScheduledDate, runDateFor } from "./automation";
import { notificationFor } from "./server/notificationRules";

describe("Recurring schedules", () => {
    test("weekly and every two weeks step from the start", () => {
        assert.equal(nextScheduledDate("weekly", "2026-10-05", "2026-10-28"), "2026-11-02");
        assert.equal(nextScheduledDate("biweekly", "2026-10-05", "2026-10-28"), "2026-11-02");
        assert.equal(nextScheduledDate("biweekly", "2026-10-05", "2026-10-20"), "2026-11-02");
        assert.equal(nextScheduledDate("weekly", "2026-11-10", "2026-10-28"), "2026-11-10", "not before the start");
    });

    test("monthly keeps the day, or the month's last day", () => {
        assert.equal(nextScheduledDate("monthly", "2026-01-31", "2026-02-01"), "2026-02-28");
        assert.equal(followingDate("monthly", "2026-01-31", "2026-02-28"), "2026-03-31");
        assert.equal(nextScheduledDate("monthly", "2026-10-15", "2026-10-16"), "2026-11-15");
        assert.equal(followingDate("monthly", "2026-12-15", "2026-12-15"), "2027-01-15");
    });

    test("daily is every day, and a date the market's closed runs the next trading day", () => {
        assert.equal(followingDate("daily", "2026-10-01", "2026-10-30"), "2026-10-31");
        assert.equal(runDateFor("2026-10-31"), "2026-11-02", "Saturday → Monday");
        assert.equal(runDateFor("2026-11-26"), "2026-11-27", "Thanksgiving → Friday");
        assert.equal(runDateFor("2026-10-28"), "2026-10-28");
    });
});

describe("Price alerts", () => {
    const quote = (price: number, previousClose: number | null = 100) => ({ price, previousClose });

    test("a level alert fires when the price crosses it", () => {
        assert.equal(alertFires({ condition: "above", threshold: 105, lastPrice: 104, triggeredOn: null }, quote(105.1), "2026-10-28"), true);
        assert.equal(alertFires({ condition: "above", threshold: 105, lastPrice: 106, triggeredOn: null }, quote(107), "2026-10-28"), false, "already above");
        assert.equal(alertFires({ condition: "below", threshold: 95, lastPrice: 96, triggeredOn: null }, quote(95), "2026-10-28"), true);
        assert.equal(alertFires({ condition: "below", threshold: 95, lastPrice: null, triggeredOn: null }, quote(90), "2026-10-28"), false, "no baseline yet");
    });

    test("a change alert fires once a day when the day's move reaches it", () => {
        assert.equal(alertFires({ condition: "change_up", threshold: 5, lastPrice: 100, triggeredOn: null }, quote(105.5), "2026-10-28"), true);
        assert.equal(alertFires({ condition: "change_up", threshold: 5, lastPrice: 100, triggeredOn: "2026-10-28" }, quote(106), "2026-10-28"), false);
        assert.equal(alertFires({ condition: "change_down", threshold: 3, lastPrice: 100, triggeredOn: "2026-10-27" }, quote(96.9), "2026-10-28"), true);
        assert.equal(alertFires({ condition: "change_down", threshold: 3, lastPrice: 100, triggeredOn: null }, quote(96.9, null), "2026-10-28"), false);
    });
});

describe("Notifications from broker events", () => {
    const trade = (payload: Record<string, unknown>) => notificationFor({ id: "e1", stream: "trades", payload });

    test("fills, broker cancellations, expiries and corporate action adjustments notify; the user's own actions don't", () => {
        assert.deepEqual(trade({ event: "fill", qty: "2", price: "11.74", order: { side: "buy", symbol: "F", client_order_id: "x" } }),
            { kind: "orders", title: "Bought 2 F at $11.74", body: "", link: "/transactions?tab=trades", dedupeKey: "event:e1" });
        assert.equal(trade({ event: "canceled", order: { side: "buy", symbol: "F", qty: "1", type: "limit", limit_price: "5" } }), null);
        assert.equal(trade({ event: "canceled", reason: "FOK order couldn't fill in full", order: { side: "buy", symbol: "F", qty: "1", type: "limit", limit_price: "5" } })!.title, "Order cancelled: Buy 1 F limit $5.00");
        assert.equal(trade({ event: "expired", order: { side: "sell", symbol: "F", qty: "3", type: "market" } })!.title, "Order expired: Sell 3 F");
        assert.equal(trade({ event: "replaced", reason: "CORPORATE_ACTION", order: { side: "buy", symbol: "F", qty: "20", type: "limit", limit_price: "4" } })!.kind, "orders");
        for (const event of ["new", "accepted", "pending_cancel", "pending_replace"]) assert.equal(trade({ event, order: {} }), null, event);
    });

    test("liquidations, recurring buys and reinvested dividends have their own kinds", () => {
        assert.equal(trade({ event: "fill", qty: "5", price: "10", order: { side: "sell", symbol: "F", client_order_id: "liquidation-1" } })!.kind, "margin");
        assert.equal(trade({ event: "fill", qty: "0.5", price: "10", order: { side: "buy", symbol: "F", client_order_id: "recurring-a-2026-10-28" } })!.kind, "recurring");
        assert.equal(trade({ event: "fill", qty: "0.5", price: "10", order: { side: "buy", symbol: "F", client_order_id: "drip-abc" } })!.body, "Dividend reinvested.");
    });

    test("account status, margin calls, transfers and activities", () => {
        assert.equal(notificationFor({ id: "a", stream: "accounts", payload: { status_from: "APPROVED", status_to: "ACTIVE" } })!.title, "Your account is open");
        assert.equal(notificationFor({ id: "a", stream: "accounts", payload: { status_from: "", status_to: "SUBMITTED" } }), null);
        assert.equal(notificationFor({ id: "m", stream: "accounts", payload: { event: "margin_call", margin_call: { type: "maintenance", amount: "101" } } })!.title, "A maintenance margin call of $101.00");
        assert.equal(notificationFor({ id: "t", stream: "transfers", payload: { status_from: "SENT_TO_CLEARING", status_to: "COMPLETE" } })!.kind, "transfers");
        assert.equal(notificationFor({ id: "t", stream: "transfers", payload: { status_from: "", status_to: "QUEUED" } }), null);
        const nta = (payload: Record<string, unknown>) => notificationFor({ id: "n", stream: "nta", payload });
        assert.equal(nta({ activity_type: "DIV", activity_sub_type: "CDIV", net_amount: "6.5", symbol: "KO" })!.title, "Dividend received: $6.50 from KO");
        assert.equal(nta({ activity_type: "FEE", activity_sub_type: "REG", net_amount: "-0.01" }), null, "regulatory fees don't notify");
        assert.equal(nta({ activity_type: "FEE", net_amount: "-25", description: "Wire fee" })!.title, "Fee charged: $25.00");
        assert.equal(nta({ activity_type: "SPLIT", description: "F 2-for-1 split" })!.kind, "corporate_actions");
        assert.equal(nta({ activity_type: "CSD", net_amount: "500" }), null, "deposits notify from the transfers stream");
    });
});
