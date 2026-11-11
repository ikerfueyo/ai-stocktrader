import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alertFires, browserNotificationsToShow, followingDate, nextScheduledDate, runDateFor } from "./automation";
import type { NotificationItem, NotificationPreferences } from "./types";
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

    test("the option fees left from when options were offered don't notify", () => {
        const nta = (payload: Record<string, unknown>) => notificationFor({ id: "n", stream: "nta", payload });
        assert.equal(nta({ activity_type: "FEE", activity_sub_type: "ORF", net_amount: "-0.02" }), null);
        assert.equal(nta({ activity_type: "FEE", activity_sub_type: "OCC", net_amount: "-0.03" }), null);
    });

    test("account status, margin calls, transfers and activities", () => {
        assert.equal(notificationFor({ id: "a", stream: "accounts", payload: { status_from: "APPROVED", status_to: "ACTIVE" } })!.title, "Your account is open");
        assert.equal(notificationFor({ id: "a", stream: "accounts", payload: { status_from: "", status_to: "SUBMITTED" } }), null);
        // Alpaca's multiplier change event
        assert.equal(notificationFor({ id: "x", stream: "accounts", payload: { account_number: "1", multiplier_from: "1", multiplier_to: "4" } })!.title, "Margin is on: 4× buying power");
        assert.equal(notificationFor({ id: "y", stream: "accounts", payload: { multiplier_from: "4", multiplier_to: "1" } })!.title, "Your buying power is now 1×");
        assert.equal(notificationFor({ id: "z", stream: "accounts", payload: { multiplier_from: "4", multiplier_to: "4" } }), null);
        assert.equal(notificationFor({ id: "m", stream: "accounts", payload: { event: "margin_call", margin_call: { type: "maintenance", amount: "101" } } })!.title, "A maintenance margin call of $101.00");
        const intraday = (event: string, deficit: Record<string, unknown>) => notificationFor({ id: "i", stream: "accounts", payload: { event, intraday_margin_deficit: deficit } })!;
        const deficit = intraday("intraday_margin_deficit", { amount: "2000", date: "2026-11-02", restrict_on: "2026-11-09" });
        assert.deepEqual([deficit.kind, deficit.title], ["margin", "An intraday margin deficit of $2,000.00 on 2026-11-02"]);
        assert.match(deficit.body, /by the close on 2026-11-09/);
        assert.equal(intraday("intraday_margin_deficit_met", { amount: "2000", date: "2026-11-02" }).title, "Your intraday margin deficit of $2,000.00 on 2026-11-02 is met");
        assert.match(intraday("intraday_margin_restriction", { amount: "2000", date: "2026-11-02", restricted_until: "2027-02-07" }).body, /until 2027-02-07/);
        assert.equal(notificationFor({ id: "t", stream: "transfers", payload: { status_from: "SENT_TO_CLEARING", status_to: "COMPLETE" } })!.kind, "transfers");
        assert.equal(notificationFor({ id: "t", stream: "transfers", payload: { status_from: "", status_to: "QUEUED" } }), null);
        // With the transfer looked up, it says which one
        const transfer = (status_to: string, transfer: Record<string, unknown>) => notificationFor({ id: "t", stream: "transfers", payload: { status_from: "", status_to, transfer } })!;
        assert.deepEqual(
            [transfer("COMPLETE", { type: "ach", direction: "OUTGOING", amount: "20" }).title, transfer("COMPLETE", { type: "ach", direction: "OUTGOING", amount: "20" }).body],
            ["Your $20.00 ACH withdrawal completed", "It has arrived at your bank."]
        );
        assert.equal(transfer("COMPLETE", { type: "wire", direction: "OUTGOING", amount: "30" }).title, "Your $30.00 wire withdrawal completed");
        assert.equal(transfer("COMPLETE", { type: "ach", direction: "INCOMING", amount: "500" }).body, "It has settled in your account.");
        const returned = transfer("RETURNED", { type: "ach", direction: "INCOMING", amount: "100.01", reason: "R01: Insufficient funds" });
        assert.deepEqual([returned.title, returned.body], ["Your $100.01 ACH deposit was returned by the bank", "R01: Insufficient funds. Its credit and a return fee were taken back."]);
        const nta = (payload: Record<string, unknown>) => notificationFor({ id: "n", stream: "nta", payload });
        assert.equal(nta({ activity_type: "DIV", activity_sub_type: "CDIV", net_amount: "6.5", symbol: "KO" })!.title, "Dividend received: $6.50 from KO");
        assert.equal(nta({ activity_type: "FEE", activity_sub_type: "REG", net_amount: "-0.01" }), null, "regulatory fees don't notify");
        assert.equal(nta({ activity_type: "FEE", net_amount: "-25", description: "Wire fee" })!.title, "Fee charged: $25.00");
        assert.equal(nta({ activity_type: "SPLIT", description: "F 2-for-1 split" })!.kind, "corporate_actions");
        assert.equal(nta({ activity_type: "CSD", net_amount: "500" }), null, "deposits notify from the transfers stream");
    });
});

describe("Browser notifications", () => {
    const item = (id: number, kind: NotificationItem["kind"], read = false): NotificationItem => ({ id, kind, title: `#${id}`, body: "", link: null, createdAt: "2026-10-29T14:00:00Z", read });
    const preferences = { orders: { inApp: true, browser: true }, transfers: { inApp: true, browser: false } } as NotificationPreferences;
    // Newest first, as the route returns them
    const items = [item(7, "orders"), item(6, "transfers"), item(5, "orders", true), item(4, "orders"), item(3, "orders")];

    test("new unread ones of the kinds on for the browser, oldest first", () => {
        assert.deepEqual(browserNotificationsToShow(items, 3, preferences).map(({ id }) => id), [4, 7]);
        assert.deepEqual(browserNotificationsToShow(items, 7, preferences), [], "nothing newer");
    });

    test("none on the first load", () => {
        assert.deepEqual(browserNotificationsToShow(items, null, preferences), []);
    });
});
