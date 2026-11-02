import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { conformanceErrors } from "../conformance";
import { assetId, toAccount, toAchRelationship, toActivity, toAsset, toBank, toCalendar, toClock, toFillActivity, toOptionsApproval, toOrder, toTransfer, type SimAccountRow, type SimActivityRow, type SimOrderRow } from "./shapes";
import { defaultConfigurations } from "./kyc";
import { toAlpacaPosition, toTradeAccount } from "./tradeAccount";

const row: SimAccountRow = {
    id: "6c1b2f0e-6a77-4d5e-9a3a-1f4b7f6d0a11",
    account_number: "912345678",
    account_type: "trading",
    account_sub_type: null,
    status: "ACTIVE",
    status_due_at: null,
    contact: { email_address: "test@example.com", phone_number: "+15555550100", street_address: ["20 N San Mateo Dr"], city: "San Mateo", state: "CA", postal_code: "94401", country: "USA" },
    identity: {
        given_name: "Test", family_name: "User", date_of_birth: "1990-01-15", tax_id: "XXX-XX-6789", tax_id_type: "USA_SSN",
        country_of_citizenship: "USA", country_of_tax_residence: "USA", funding_source: ["employment_income"]
    },
    disclosures: { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false, employment_status: "retired" },
    agreements: [{ agreement: "customer_agreement", signed_at: "2026-10-27T15:00:00Z", ip_address: "127.0.0.1" }],
    trusted_contact: { given_name: "Jane", family_name: "Doe", email_address: "jane@example.com" },
    enabled_assets: ["us_equity"],
    kyc_results: { summary: "pass" },
    configurations: defaultConfigurations(["customer_agreement", "account_agreement"]),
    options_approved_level: 0,
    documents: [{ id: "0d18ae51-3c94-4511-b209-101e1666416b", document_type: "identity_verification", document_sub_type: "passport", mime_type: "image/jpeg", created_at: "2026-10-27T15:00:00Z", size: 10, sha256: "x" }],
    trading_blocked: false, transfers_blocked: false, account_blocked: false,
    created_at: new Date("2026-10-27T15:00:00Z"), updated_at: new Date("2026-10-27T15:00:00Z"), closed_at: null
};

describe("The simulator's replies conform to Alpaca's spec", () => {
    test("an account", () => {
        assert.deepEqual(conformanceErrors(toAccount(row), "AccountExtended"), []);
    });

    test("an asset, with and without Alpaca's flags", () => {
        const base = { symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ", borrowStatus: null, marginRequirementLong: null, marginRequirementShort: null, attributes: [] };
        const unflagged = toAsset({ ...base, alpacaId: null, tradable: null, marginable: null, shortable: null, fractionable: null });
        assert.deepEqual(conformanceErrors(unflagged, "Asset"), []);
        assert.equal(unflagged.id, assetId("AAPL"), "a stable ID");
        assert.deepEqual([unflagged.shortable, unflagged.borrow_status], [true, "easy_to_borrow"], "shortable and easy to borrow without Alpaca's flags, as the order rules treat it");
        const hard = toAsset({ ...base, alpacaId: null, tradable: null, marginable: null, shortable: null, fractionable: null }, { hardToBorrow: true });
        assert.deepEqual(conformanceErrors(hard, "Asset"), []);
        assert.equal(hard.borrow_status, "hard_to_borrow");
        const flagged = toAsset({ ...base, exchange: "NYSE MKT", alpacaId: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415", tradable: true, marginable: true, shortable: true, fractionable: true, borrowStatus: "easy_to_borrow", marginRequirementLong: 30, marginRequirementShort: 100 });
        assert.deepEqual(conformanceErrors(flagged, "Asset"), []);
        assert.equal(flagged.exchange, "AMEX");
        assert.equal(flagged.margin_requirement_short, "100");
    });

    test("the calendar skips weekends and holidays, with early closes and settlement dates", () => {
        const days = toCalendar("2026-11-25", "2026-11-30");
        assert.deepEqual(days.map(({ date }) => date), ["2026-11-25", "2026-11-27", "2026-11-30"]);
        assert.deepEqual(days[1], { date: "2026-11-27", open: "09:30", close: "13:00", session_open: "0400", session_close: "1700", settlement_date: "2026-11-30" });
        for (const day of days) assert.deepEqual(conformanceErrors(day, "legacy_calendar_day"), []);
    });

    test("the clock", () => {
        const open = toClock(new Date("2026-10-27T15:00:00Z"));
        assert.equal(open.is_open, true);
        assert.equal(open.next_close, "2026-10-27T20:00:00.000Z");
        const closed = toClock(new Date("2026-10-24T15:00:00Z"));
        assert.equal(closed.is_open, false);
        assert.equal(closed.next_open, "2026-10-26T13:30:00.000Z");
        assert.equal(closed.next_close, "2026-10-26T20:00:00.000Z");
        assert.deepEqual(conformanceErrors(closed, "legacy_clock"), []);
    });

    test("an options approval", () => {
        const approval = toOptionsApproval({ id: "0d18ae51-3c94-4511-b209-101e1666416b", account_id: row.id, requested_level: 3, approved_level: 2, status: "LOWER_LEVEL_APPROVED", created_at: row.created_at, updated_at: row.updated_at });
        assert.deepEqual(conformanceErrors(approval, "OptionsApprovalResponse"), []);
    });

    const created = new Date("2026-10-27T15:00:00Z");

    test("a bank link and a wire recipient, with masked account numbers", () => {
        const link = toAchRelationship({
            id: "0d18ae51-3c94-4511-b209-101e1666416b", account_id: row.id, status: "APPROVED", reason: null, account_owner_name: "Test User",
            bank_account_type: "CHECKING", bank_account_number: "••••6789", bank_routing_number: "011000015", nickname: null, created_at: created, updated_at: created
        });
        assert.deepEqual(conformanceErrors(link, "ACHRelationship"), []);
        const bank = toBank({
            id: "0d18ae51-3c94-4511-b209-101e1666416b", account_id: row.id, status: "APPROVED", name: "Test Bank", bank_code: "011000015",
            bank_code_type: "ABA", account_number: "••••6789", created_at: created, updated_at: created
        });
        assert.deepEqual(conformanceErrors(bank, "Bank"), []);
    });

    test("a transfer, with its expected arrival", () => {
        const transfer = toTransfer({
            id: "0d18ae51-3c94-4511-b209-101e1666416b", account_id: row.id, type: "ach", direction: "INCOMING", status: "QUEUED", amount: "600.00",
            instant_amount: "600.00", fee: "0.00", relationship_id: "6c1b2f0e-6a77-4d5e-9a3a-1f4b7f6d0a11", bank_id: null, reason: null,
            sent_at: created, complete_at: new Date("2026-10-28T13:00:00Z"), return_at: null, return_code: null, created_at: created, updated_at: created
        });
        assert.deepEqual(conformanceErrors(transfer, "Transfer"), []);
        assert.equal(transfer.amount, "600");
        assert.equal(transfer.expires_at, "2026-10-28T13:00:00.000Z");
    });

    test("a cash activity (against NonTradeActivity: Alpaca's Activity schema is a oneOf of two schemas with no required fields, which nothing can match)", () => {
        const activity = toActivity({
            id: "20261027150000000::0d18ae51-3c94-4511-b209-101e1666416b", account_id: row.id, activity_type: "CSD", activity_sub_type: null,
            date: "2026-10-27", created_at: created, net_amount: "600.00", description: "ACH deposit", status: "executed",
            transfer_id: "0d18ae51-3c94-4511-b209-101e1666416b", symbol: null, qty: null, per_share_amount: null
        });
        assert.deepEqual(conformanceErrors(activity, "NonTradeActivity"), []);
        assert.equal(activity.net_amount, "600");
    });
});

describe("The trading account and positions conform to Alpaca's spec", () => {
    const base = {
        account: {
            id: "6c1b2f0e-6a77-4d5e-9a3a-1f4b7f6d0a11", account_number: "912345678", status: "ACTIVE", created_at: new Date("2026-10-27T15:00:00Z"),
            trading_blocked: false, transfers_blocked: false, account_blocked: false,
            configurations: { max_margin_multiplier: "2", no_shorting: false, max_options_trading_level: 1 as const, suspend_trade: false }, options_approved_level: 1, hasMarginAgreement: true
        },
        state: { cash: 1500, longMarketValue: 1000, shortMarketValue: 400, buyingPower: 2800, regtBuyingPower: 2800, nonMarginableBuyingPower: 1400, initialMargin: 700, maintenanceMargin: 500, sma: 1400 },
        multiplier: 2, shortingEnabled: true, withdrawable: 800,
        accruedFees: { REG: 0.01, TAF: 0.02, CAT: 0.001 }, pendingTransferOut: 0, last: null
    };

    test("a trading account", () => {
        const account = toTradeAccount(base);
        assert.deepEqual(conformanceErrors(account, "TradeAccount"), []);
        assert.equal(account.equity, "2100.00", "cash + longs - shorts");
        assert.equal(account.short_market_value, "-400.00", "Alpaca reports shorts as negative");
        assert.equal(account.accrued_fees, "0.03");
        assert.equal(account.last_equity, "2100.00", "before the first snapshot, the current equity");
        assert.deepEqual([account.multiplier, account.buying_power, account.regt_buying_power, account.non_marginable_buying_power, account.sma], ["2", "2800.00", "2800.00", "1400.00", "1400.00"]);
        assert.equal(account.shorting_enabled, true);
        assert.equal(toTradeAccount({ ...base, shortingEnabled: false }).shorting_enabled, false);
    });

    test("long and short positions", () => {
        const asset = { id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415", exchange: "NASDAQ", marginable: true };
        const long = toAlpacaPosition({ ticker: "AAPL", quantity: 10, avgCost: 100 }, asset, { price: 110, previousClose: 105 });
        assert.deepEqual(conformanceErrors(long, "Position"), []);
        assert.deepEqual([long.side, long.market_value, long.cost_basis, long.unrealized_pl, long.unrealized_intraday_pl], ["long", "1100.00", "1000.00", "100.00", "50.00"]);
        const short = toAlpacaPosition({ ticker: "AAPL", quantity: -10, avgCost: 100 }, asset, { price: 90, previousClose: 95 });
        assert.deepEqual(conformanceErrors(short, "Position"), []);
        assert.deepEqual([short.side, short.qty, short.market_value, short.unrealized_pl], ["short", "-10", "-900.00", "100.00"], "a short gains as the price falls");
    });
});

describe("Orders and their fills conform to Alpaca's spec", () => {
    const at = new Date("2026-10-28T14:00:00Z");
    const row = (overrides: Partial<SimOrderRow> = {}): SimOrderRow => ({
        id: "2f1d7c64-8f3e-4b9a-9d0e-7b1c2a3d4e5f", account_id: "6c1b2f0e-6a77-4d5e-9a3a-1f4b7f6d0a11", client_order_id: "my-order-1", symbol: "AAPL",
        side: "buy", type: "limit", time_in_force: "gtc", order_class: "simple", position_intent: null, qty: "10.000000000", notional: null,
        limit_price: "180.000000", stop_price: null, trail_price: null, trail_percent: null, hwm: null, extended_hours: false, status: "new",
        filled_qty: "0.000000000", filled_notional: "0.00", filled_avg_price: null, parent_id: null, group_id: null, group_role: null, replaces: null,
        replaced_by: null, stop_triggered_at: null, expires_at: at, reason: null, created_at: at, updated_at: at, submitted_at: at, filled_at: null,
        expired_at: null, canceled_at: null, failed_at: null, replaced_at: null, cancel_requested_at: null, ...overrides
    });

    test("a simple limit order", () => {
        const order = toOrder(row());
        assert.deepEqual(conformanceErrors(order, "Order"), []);
        assert.deepEqual([order.qty, order.limit_price, order.filled_qty, order.filled_avg_price, order.legs], ["10", "180", "0", null, null]);
        assert.equal(order.asset_id, assetId("AAPL"));
    });

    test("a filled notional market order", () => {
        const order = toOrder(row({ type: "market", time_in_force: "day", qty: null, notional: "250.00", limit_price: null, status: "filled", filled_qty: "1.385041551", filled_notional: "250.00", filled_avg_price: "180.500000", filled_at: at }));
        assert.deepEqual(conformanceErrors(order, "Order"), []);
        assert.deepEqual([order.qty, order.notional, order.filled_qty, order.filled_avg_price], [null, "250", "1.385041551", "180.5"]);
    });

    test("a bracket with its legs nested, and a trailing stop", () => {
        const group = { group_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", order_class: "bracket" as const };
        const legs = [
            row({ ...group, id: "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d", side: "sell", limit_price: "200.000000", group_role: "take_profit", parent_id: "2f1d7c64-8f3e-4b9a-9d0e-7b1c2a3d4e5f", client_order_id: "leg-1" }),
            row({ ...group, id: "4c3b2a1d-0e9f-4b8a-9d7c-6e5f4a3b2c1d", side: "sell", type: "stop", limit_price: null, stop_price: "170.000000", group_role: "stop_loss", parent_id: "2f1d7c64-8f3e-4b9a-9d0e-7b1c2a3d4e5f", client_order_id: "leg-2" })
        ];
        // Legs only go live when the entry fills: activated, so the statuses are in the spec's enum
        const order = toOrder(row({ ...group, group_role: "entry", status: "filled", filled_qty: "10.000000000", filled_avg_price: "180.000000" }), { legs });
        assert.deepEqual(conformanceErrors(order, "Order"), []);
        assert.equal(order.legs?.length, 2);
        assert.equal("legs" in order.legs![0], false, "a nested leg has no legs of its own");
        const trailing = toOrder(row({ type: "trailing_stop", side: "sell", limit_price: null, trail_percent: "5.0000", hwm: "190.000000", stop_price: "180.500000" }));
        assert.deepEqual(conformanceErrors(trailing, "Order"), []);
        assert.deepEqual([trailing.trail_percent, trailing.hwm, trailing.stop_price], ["5", "190", "180.5"]);
    });

    test("a partial fill links its order", () => {
        const fill = toFillActivity({
            id: "20261028140000000::5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d", account_id: "6c1b2f0e-6a77-4d5e-9a3a-1f4b7f6d0a11", activity_type: "FILL", activity_sub_type: null,
            date: "2026-10-28", created_at: at, net_amount: "-1800.00", description: "Bought 10 AAPL", status: "executed", transfer_id: null, symbol: "AAPL",
            qty: "10.000000000", per_share_amount: null, side: "buy", price: "180.000000", leaves_qty: "90.000000000", cum_qty: "10.000000000",
            order_id: "2f1d7c64-8f3e-4b9a-9d0e-7b1c2a3d4e5f"
        } satisfies SimActivityRow);
        assert.deepEqual(conformanceErrors(fill, "TradeActivity"), []);
        assert.deepEqual([fill.type, fill.order_status, fill.order_id], ["partial_fill", "partially_filled", "2f1d7c64-8f3e-4b9a-9d0e-7b1c2a3d4e5f"]);
    });
});
