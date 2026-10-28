import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { backupWithholding, form1099R, form5498, reportSales, rmdAge, taxYear, termOf, type Acquisition, type Disposal } from "./tax";
import { renderDocument } from "./documentRender";

const buy = (lotId: string, qty: number, acquiredAt: string, symbol = "XYZ"): Acquisition => ({ lotId, symbol, side: "long", qty, acquiredAt: `${acquiredAt}T15:00:00Z` });
const sell = (id: string, lotId: string, qty: number, lotPrice: number, price: number, acquiredAt: string, closedAt: string, kind: Disposal["kind"] = "sale"): Disposal =>
    ({ id, lotId, symbol: "XYZ", side: "long", qty, lotPrice, price, acquiredAt: `${acquiredAt}T15:00:00Z`, closedAt: `${closedAt}T15:00:00Z`, kind });

describe("Holding periods", () => {
    test("long term after a year and a day", () => {
        assert.equal(termOf("2025-03-10T15:00:00Z", "2026-03-10T15:00:00Z"), "short");
        assert.equal(termOf("2025-03-10T15:00:00Z", "2026-03-11T15:00:00Z"), "long");
    });
});

describe("1099-B sales and wash sales (Publication 550)", () => {
    test("a gain is reported as is, short or long term", () => {
        const { sales } = reportSales([buy("a", 10, "2025-01-02")], [sell("s1", "a", 10, 50, 70, "2025-01-02", "2026-02-01")]);
        assert.deepEqual([sales[0].proceeds, sales[0].costBasis, sales[0].gain, sales[0].term, sales[0].washDisallowed], [700, 500, 200, "long", 0]);
    });

    test("a loss with a purchase within 30 days is disallowed and moves to the replacement shares", () => {
        // Publication 550's example: 100 shares bought at $1,000 sold for $750, 100 more bought 11 days later for $800
        const acquisitions = [buy("a", 100, "2026-01-05"), buy("b", 100, "2026-03-10")];
        const disposals = [sell("s1", "a", 100, 10, 7.5, "2026-01-05", "2026-02-27"), sell("s2", "b", 100, 8, 9, "2026-03-10", "2026-06-01")];
        const { sales, adjustments } = reportSales(acquisitions, disposals);
        assert.deepEqual([sales[0].gain, sales[0].washDisallowed], [0, 250], "the $250 loss is disallowed");
        assert.deepEqual(adjustments.get("b"), { basis: 250, carriedDays: 53 });
        // The replacement's basis is $800 + $250, and its holding period starts 53 days earlier
        assert.deepEqual([sales[1].costBasis, sales[1].gain, sales[1].dateAcquired.slice(0, 10)], [1050, -150, "2026-01-16"]);
    });

    test("only as many shares as were replaced are washed", () => {
        const { sales } = reportSales([buy("a", 100, "2026-01-05"), buy("b", 40, "2026-02-10")], [sell("s1", "a", 100, 10, 8, "2026-01-05", "2026-02-01")]);
        assert.deepEqual([sales[0].gain, sales[0].washDisallowed], [-120, 80]);
    });

    test("purchases more than 30 days away, other symbols and the sold lot itself don't wash", () => {
        const { sales } = reportSales(
            [buy("a", 100, "2026-01-05"), buy("b", 100, "2026-03-15"), buy("c", 100, "2026-02-10", "OTHER")],
            [sell("s1", "a", 100, 10, 8, "2026-01-05", "2026-02-01")]
        );
        assert.equal(sales[0].washDisallowed, 0);
        assert.equal(sales[0].gain, -200);
    });

    test("a purchase within 30 days before the sale washes too", () => {
        const { sales } = reportSales([buy("a", 100, "2026-01-05"), buy("b", 100, "2026-01-20")], [sell("s1", "a", 100, 10, 8, "2026-01-05", "2026-02-10")]);
        assert.equal(sales[0].washDisallowed, 200);
    });

    test("cash mergers and worthless removals are reported but don't wash", () => {
        const { sales } = reportSales([buy("a", 10, "2026-01-05"), buy("b", 10, "2026-01-20")], [
            sell("m", "a", 10, 50, 40, "2026-01-05", "2026-02-01", "merger"), sell("w", "b", 10, 30, 0, "2026-01-20", "2026-02-02", "worthless")
        ]);
        assert.deepEqual(sales.map(({ gain, washDisallowed }) => [gain, washDisallowed]), [[-100, 0], [-300, 0]]);
    });

    test("a short sale reports what it sold for as proceeds, short term", () => {
        const { sales } = reportSales([], [{ id: "s", lotId: "x", symbol: "XYZ", side: "short", qty: 10, lotPrice: 50, price: 40, acquiredAt: "2024-01-05T15:00:00Z", closedAt: "2026-02-01T15:00:00Z", kind: "sale" }]);
        assert.deepEqual([sales[0].proceeds, sales[0].costBasis, sales[0].gain, sales[0].term], [500, 400, 100, "short"]);
    });
});

describe("The year's 1099 figures", () => {
    const { sales } = reportSales([buy("a", 10, "2025-01-02"), buy("b", 10, "2026-01-02")], [
        sell("s1", "a", 10, 50, 70, "2025-01-02", "2026-02-01"), sell("s2", "b", 10, 50, 45, "2026-01-02", "2026-03-01"), sell("s3", "b", 0.000001, 50, 45, "2026-01-02", "2027-01-05")
    ]);

    test("1099-B totals the year's sales by term", () => {
        const year = taxYear({ year: 2026, sales, dividends: [], interest: [], withholding: [] });
        assert.equal(year.form1099B.sales.length, 2);
        assert.deepEqual(year.form1099B.totals.long, { proceeds: 700, costBasis: 500, washDisallowed: 0, gain: 200 });
        assert.deepEqual(year.form1099B.totals.short, { proceeds: 450, costBasis: 500, washDisallowed: 0, gain: -50 });
    });

    test("1099-DIV counts dividends received as ordinary, from $10, with backup withholding", () => {
        const dividends = [{ date: "2026-03-01", amount: 6 }, { date: "2026-06-01", amount: 6 }, { date: "2026-07-01", amount: -3 }, { date: "2025-12-01", amount: 50 }];
        const year = taxYear({ year: 2026, sales: [], dividends, interest: [], withholding: [{ date: "2026-06-01", amount: 1.44, on: "dividends" }] });
        assert.deepEqual(year.form1099DIV, { ordinaryDividends: 12, qualifiedDividends: 0, federalWithheld: 1.44, required: true });
        assert.equal(taxYear({ year: 2026, sales: [], dividends: [{ date: "2026-03-01", amount: 9.99 }], interest: [], withholding: [] }).form1099DIV.required, false);
        assert.equal(taxYear({ year: 2026, sales: [], dividends: [], interest: [], withholding: [] }).form1099INT.required, false);
    });

    test("backup withholding is 24%", () => {
        assert.equal(backupWithholding(100), 24);
        assert.equal(backupWithholding(12.345), 2.96);
        assert.equal(backupWithholding(-5), 0);
    });
});

describe("IRA forms", () => {
    test("1099-R: a line per distribution code, taxable in full from a traditional IRA, with the withholding", () => {
        const form = form1099R({ year: 2026, subType: "traditional", distributions: [
            { date: "2026-03-01", gross: 1000, fedWithheld: 100, stateWithheld: 50, code: "1" },
            { date: "2026-06-01", gross: 500, fedWithheld: 50, stateWithheld: 0, code: "1" },
            { date: "2025-12-01", gross: 900, fedWithheld: 90, stateWithheld: 0, code: "1" }
        ] });
        assert.deepEqual(form.lines, [{ code: "1", gross: 1500, taxable: 1500, taxableNotDetermined: false, fedWithheld: 150, stateWithheld: 50 }]);
        assert.equal(form.traditional, true);
        assert.equal(form.required, true);
    });

    test("1099-R: a qualified Roth distribution isn't taxable; other Roth distributions are left undetermined", () => {
        const form = form1099R({ year: 2026, subType: "roth", distributions: [
            { date: "2026-03-01", gross: 400, fedWithheld: 0, stateWithheld: 0, code: "Q" }, { date: "2026-04-01", gross: 300, fedWithheld: 30, stateWithheld: 0, code: "J" }
        ] });
        assert.deepEqual(form.lines.map(({ code, taxable, taxableNotDetermined }) => [code, taxable, taxableNotDetermined]), [["Q", 0, false], ["J", null, true]]);
        assert.equal(form1099R({ year: 2026, subType: "roth", distributions: [] }).required, false);
    });

    test("5498: the tax year's contributions (made by the next April 15), the year-end value, and the RMD box", () => {
        const contributions = [{ taxYear: 2026, amount: 5000 }, { taxYear: 2026, amount: 2500 }, { taxYear: 2025, amount: 7000 }];
        assert.deepEqual(form5498({ year: 2026, subType: "roth", contributions, fairMarketValue: 7712.345, dateOfBirth: "1950-01-01" }),
            { year: 2026, contributions: 7500, traditional: false, fairMarketValue: 7712.35, rmdNextYear: false });
        assert.equal(form5498({ year: 2026, subType: "traditional", contributions, fairMarketValue: 0, dateOfBirth: "1954-05-01" }).rmdNextYear, true, "73 in 2027");
        assert.equal(form5498({ year: 2026, subType: "traditional", contributions, fairMarketValue: 0, dateOfBirth: "1960-05-01" }).rmdNextYear, false, "75 only in 2035");
        assert.deepEqual([rmdAge("1950-06-01"), rmdAge("1955-06-01"), rmdAge("1960-06-01")], [72, 73, 75]);
    });
});

describe("Documents render as printable pages", () => {
    const holder = { name: "Ada <Lovelace>", accountNumber: "912345678", address: ["1 Main St", "Springfield, IL 62701"] };

    test("a consolidated 1099 shows each form, the wash sale code and the simulation notice, with text escaped", () => {
        const { sales } = reportSales([buy("a", 100, "2026-01-05"), buy("b", 100, "2026-03-10")], [sell("s1", "a", 100, 10, 7.5, "2026-01-05", "2026-02-27")]);
        const html = renderDocument({
            type: "tax_statement", name: "Consolidated 1099 for 2026", date: "2027-02-15", preliminary: false,
            payload: { holder, backupWithholding: false, taxYear: taxYear({ year: 2026, sales, dividends: [{ date: "2026-03-01", amount: 12 }], interest: [], withholding: [] }) }
        });
        for (const text of ["1099-DIV", "1099-INT", "1099-B", "$250.00 W", "Simulated document", "Ada &lt;Lovelace&gt;", "$12.00"]) assert.ok(html.includes(text), text);
        assert.ok(!html.includes("<Lovelace>"));
    });

    test("a trade confirmation lists each fill", () => {
        const html = renderDocument({
            type: "trade_confirmation", name: "Trade confirmation 2026-10-27", date: "2026-10-27", preliminary: true,
            payload: { holder, tradeDate: "2026-10-27", fills: [{ time: "2026-10-27T14:00:00Z", side: "buy", symbol: "F", qty: 1, price: 11.74, principal: 11.74, fees: { REG: 0, TAF: 0, CAT: 0.000001 }, settleDate: "2026-10-28", orderId: null, liquidation: false }] }
        });
        for (const text of ["Bought", "$11.74", "2026-10-28", "preliminary"]) assert.ok(html.includes(text), text);
    });
});
