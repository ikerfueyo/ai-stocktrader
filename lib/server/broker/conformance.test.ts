import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { conformanceErrors } from "./conformance";
import type { Asset, Order } from "./types";

// An order as Alpaca returns it, with its decimals as strings
const order: Order = {
    id: "61e69015-8549-4bfd-b9c3-01e75843f47d",
    client_order_id: "eb9e2aaa-f71a-4f51-b5b4-52a6c565dad4",
    created_at: "2026-10-27T14:31:02.104Z",
    updated_at: "2026-10-27T14:31:02.104Z",
    submitted_at: "2026-10-27T14:31:02.098Z",
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
    symbol: "AAPL",
    asset_class: "us_equity",
    notional: null,
    qty: "2",
    filled_qty: "0",
    filled_avg_price: null,
    order_class: "simple",
    order_type: "limit",
    type: "limit",
    side: "buy",
    time_in_force: "day",
    limit_price: "180.5",
    stop_price: null,
    status: "new",
    extended_hours: false,
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
    commission: "0",
    position_intent: "buy_to_open"
};

describe("Alpaca OpenAPI conformance", () => {
    test("an order in Alpaca's shape conforms", () => {
        assert.deepEqual(conformanceErrors(order, "Order"), []);
    });

    test("a wrong enum value or type is caught", () => {
        assert.notDeepEqual(conformanceErrors({ ...order, side: "long" }, "Order"), []);
        assert.notDeepEqual(conformanceErrors({ ...order, extended_hours: "no" }, "Order"), []);
    });

    test("an asset needs the per-asset margin requirements", () => {
        const asset: Asset = {
            id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
            class: "us_equity",
            exchange: "NASDAQ",
            symbol: "AAPL",
            name: "Apple Inc. Common Stock",
            status: "active",
            tradable: true,
            marginable: true,
            shortable: true,
            fractionable: true,
            margin_requirement_long: "30",
            margin_requirement_short: "30"
        };
        assert.deepEqual(conformanceErrors(asset, "Asset"), []);
        const withoutRequirement: Partial<Asset> = { ...asset };
        delete withoutRequirement.margin_requirement_long;
        assert.notDeepEqual(conformanceErrors(withoutRequirement, "Asset"), []);
    });
});
