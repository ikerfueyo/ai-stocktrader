import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildUniverse, normalizeSymbol, type AlpacaAssetInput, type ListingInput } from "./universe";

const listing = (symbol: string, overrides: Partial<ListingInput> = {}): ListingInput =>
    ({ symbol, name: `${symbol} Inc`, exchange: "NASDAQ", assetType: "Stock", ...overrides });
const alpaca = (symbol: string, overrides: Partial<AlpacaAssetInput> = {}): AlpacaAssetInput => ({
    id: `id-${symbol}`, symbol, exchange: "NASDAQ", tradable: true, marginable: true, shortable: true, fractionable: true,
    borrow_status: "easy_to_borrow", margin_requirement_long: "30", margin_requirement_short: "30", attributes: ["has_options"],
    ...overrides
});

describe("The tradable universe", () => {
    test("keeps listed common stocks and drops ETFs, OTC listings, warrants, units and preferreds", () => {
        const symbols = buildUniverse([
            listing("AAPL"),
            listing("SPY", { assetType: "ETF", exchange: "NYSE ARCA" }),
            listing("OTCX", { exchange: "OTC" }),
            listing("ABCDW"), listing("ABCDU"), listing("ABCDEF"),
            listing("XYZ", { name: "XYZ Corp 6.5% Series A Preferred Stock", exchange: "NYSE" }),
            listing("QRS", { name: "QRS Acquisition Corp Warrants", exchange: "NYSE" }),
            listing("BRK-B", { exchange: "NYSE" }),
            listing("TSM", { name: "Taiwan Semiconductor Manufacturing American Depositary Shares", exchange: "NYSE" })
        ], null).map(({ symbol }) => symbol);
        assert.deepEqual(symbols, ["AAPL", "BRK.B", "TSM"], "ADRs are common shares");
    });

    test("without Alpaca, every listed stock counts with unknown flags", () => {
        const [row] = buildUniverse([listing("AAPL")], null);
        assert.equal(row.tradable, null);
        assert.equal(row.shortable, null);
        assert.equal(row.alpacaId, null);
    });

    test("with Alpaca, a stock must also be tradable there, and gets its flags", () => {
        const rows = buildUniverse(
            [listing("AAPL"), listing("GONE"), listing("HALT"), listing("BRK-B", { exchange: "NYSE" })],
            [alpaca("AAPL"), alpaca("HALT", { tradable: false }), alpaca("BRK.B", { exchange: "NYSE", shortable: false, borrow_status: null, marginable: false })]
        );
        assert.deepEqual(rows.map(({ symbol }) => symbol), ["AAPL", "BRK.B"]);
        assert.deepEqual(rows[0], {
            symbol: "AAPL", name: "AAPL Inc", exchange: "NASDAQ", alpacaId: "id-AAPL", tradable: true, marginable: true, shortable: true,
            borrowStatus: "easy_to_borrow", fractionable: true, marginRequirementLong: 30, marginRequirementShort: 30, attributes: ["has_options"]
        });
        assert.equal(rows[1].shortable, false);
        assert.equal(rows[1].borrowStatus, null);
    });

    test("share classes are written with a dot", () => {
        assert.equal(normalizeSymbol("brk-a"), "BRK.A");
        assert.equal(normalizeSymbol("BRK.A"), "BRK.A");
    });
});
