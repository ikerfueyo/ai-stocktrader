import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    accountSummary, cashRowsOf, fillsOf, ledgerOf, listAllActivities, optionEventsOf, orderFillRows, replayFills, taxLotsOf, taxReportOf, toAppPositions, tradesOf,
    transactionRowsOf, type ShareAction
} from "./brokerLedger";
import type { CorporateAction } from "./broker/sim/corporateActions";
import type { Activity, Order, Position, TradeAccount } from "./broker/types";

// A FILL activity as Alpaca's /v1/accounts/activities returns it
const fill = (id: string, symbol: string, side: "buy" | "sell", qty: number, price: number, at: string, order_id = `order-${id}`) =>
    ({ id, activity_type: "FILL", type: "fill", symbol, side, qty: String(qty), price: String(price), transaction_time: at, order_id, cum_qty: String(qty), leaves_qty: "0" }) as unknown as Activity;
const cash = (id: string, activity_type: string, net_amount: number, date: string, extra: Record<string, unknown> = {}) =>
    ({ id, activity_type, net_amount: String(net_amount), date, created_at: `${date}T15:00:00Z`, description: activity_type, status: "executed", ...extra }) as unknown as Activity;

describe("activities", () => {
    test("every page is followed with the last ID as the page token", async () => {
        const all = Array.from({ length: 230 }, (_, index) => cash(`a${String(index).padStart(3, "0")}`, "CSD", 1, "2026-10-01"));
        const tokens: (string | undefined)[] = [];
        const broker = {
            listActivities: async (_: string, query: { page_token?: string; page_size?: number; direction?: string; activity_types?: string }) => {
                tokens.push(query.page_token);
                assert.equal(query.direction, "asc");
                assert.equal(query.activity_types, "FILL,CSD");
                const start = query.page_token ? all.findIndex(({ id }) => id === query.page_token) + 1 : 0;
                return all.slice(start, start + (query.page_size ?? 100));
            }
        };
        const listed = await listAllActivities(broker as never, "acct", ["FILL", "CSD"]);
        assert.equal(listed.length, 230);
        assert.deepEqual(tokens, [undefined, "a099", "a199"]);
    });

    test("fills are read oldest first, without empty ones", () => {
        const fills = fillsOf([fill("2", "AAPL", "sell", 1, 110, "2026-10-02T15:00:00Z"), cash("c", "CSD", 100, "2026-10-01"), fill("1", "aapl", "buy", 2, 100, "2026-10-01T15:00:00Z"), fill("3", "F", "buy", 0, 10, "2026-10-03T15:00:00Z")]);
        assert.deepEqual(fills.map(({ id, symbol }) => `${id}:${symbol}`), ["1:AAPL", "2:AAPL"]);
        assert.deepEqual(tradesOf(fills).map(({ type, total }) => `${type} ${total}`), ["BUY 200.00", "SELL 110.00"]);
    });
});

describe("FIFO replay", () => {
    test("sales close the oldest lots first and realize against them", () => {
        const replay = replayFills(fillsOf([
            fill("1", "AAPL", "buy", 10, 100, "2026-09-01T15:00:00Z"),
            fill("2", "AAPL", "buy", 5, 110, "2026-09-02T15:00:00Z"),
            fill("3", "AAPL", "sell", 12, 120, "2026-09-03T15:00:00Z")
        ]), [], "2026-10-28");
        assert.equal(replay.realized, 220);
        assert.equal(replay.realizedByFill.get("1"), null);
        assert.equal(replay.realizedByFill.get("3"), 220);
        assert.deepEqual(replay.lots.map(({ qty, price }) => [qty, price]), [[3, 110]]);
    });

    test("a short realizes the reverse, and option contracts count 100 shares", () => {
        const replay = replayFills(fillsOf([
            fill("1", "F", "sell", 5, 50, "2026-09-01T15:00:00Z"),
            fill("2", "F", "buy", 2, 40, "2026-09-02T15:00:00Z"),
            fill("3", "F261120C00012000", "buy", 1, 2, "2026-09-03T15:00:00Z"),
            fill("4", "F261120C00012000", "sell", 1, 3.5, "2026-09-04T15:00:00Z")
        ]), [], "2026-10-28");
        assert.equal(replay.realizedByFill.get("2"), 20);
        assert.equal(replay.realizedByFill.get("4"), 150);
        assert.deepEqual(replay.lots.map(({ symbol, side, qty }) => [symbol, side, qty]), [["F", "short", 3]]);
    });

    test("splits apply to the lots acquired before them, before later fills and through today", () => {
        const splits = [{ ticker: "NVDA", exDate: "2026-09-10", factor: 2 }, { ticker: "NVDA", exDate: "2026-10-20", factor: 3 }];
        const replay = replayFills(fillsOf([
            fill("1", "NVDA", "buy", 10, 100, "2026-09-01T15:00:00Z"),
            // After the 2-for-1: 20 shares at 50
            fill("2", "NVDA", "sell", 5, 60, "2026-09-15T15:00:00Z")
        ]), splits, "2026-10-28");
        assert.equal(replay.realizedByFill.get("2"), 50);
        // 15 shares at 50, then the 3-for-1
        const [lot] = replay.lots;
        assert.equal(lot.qty, 45);
        assert.ok(Math.abs(lot.price - 50 / 3) < 1e-9);
        assert.equal(lot.originalQty, 60);
        const [taxLot] = taxLotsOf(replay, "NVDA", "2026-10-28T00:00:00Z");
        assert.equal(taxLot.costBasis, 750);
        assert.equal(taxLot.longTerm, false);
    });

    test("a split after today isn't applied yet", () => {
        const replay = replayFills(fillsOf([fill("1", "NVDA", "buy", 10, 100, "2026-09-01T15:00:00Z")]), [{ ticker: "NVDA", exDate: "2026-11-02", factor: 2 }], "2026-10-28");
        assert.equal(replay.lots[0].qty, 10);
    });
});

// A stored corporate action, with the effective date's closes
const action = (fields: Partial<CorporateAction> & Pick<CorporateAction, "type" | "symbol" | "exDate">, prices = { symbol: null, newSymbol: null } as ShareAction["prices"]): ShareAction =>
    ({ action: { newSymbol: null, factor: null, cash: null, ...fields }, prices });

describe("corporate actions and option events in the replay", () => {
    test("a stock merger moves the lots to the acquirer at its ratio, keeping their basis and acquisition date", () => {
        const replay = replayFills(fillsOf([
            fill("1", "AAA", "buy", 10, 100, "2026-09-01T15:00:00Z"),
            fill("2", "BBB", "sell", 3, 250, "2026-09-15T15:00:00Z")
        ]), [], "2026-10-28", { actions: [action({ type: "STOCK_MERGER", symbol: "AAA", newSymbol: "BBB", factor: 0.5, exDate: "2026-09-10" })] });
        assert.equal(replay.realizedByFill.get("2"), 150);
        assert.deepEqual(replay.lots.map(({ symbol, qty, price, acquiredAt, originalQty }) => [symbol, qty, price, acquiredAt, originalQty]), [["BBB", 2, 200, "2026-09-01T15:00:00Z", 5]]);
        assert.deepEqual(replay.acquisitions.map(({ symbol, qty }) => [symbol, qty]), [["BBB", 5]]);
    });

    test("a spinoff splits the basis by market value into new lots that aren't purchases", () => {
        const replay = replayFills(fillsOf([fill("1", "PAR", "buy", 10, 100, "2026-09-01T15:00:00Z")]), [], "2026-10-28", {
            actions: [action({ type: "SPINOFF", symbol: "PAR", newSymbol: "KID", factor: 1, exDate: "2026-09-10" }, { symbol: 80, newSymbol: 20 })]
        });
        assert.deepEqual(replay.lots.map(({ symbol, qty, price, acquiredAt }) => [symbol, qty, price, acquiredAt]), [
            ["PAR", 10, 80, "2026-09-01T15:00:00Z"], ["KID", 10, 20, "2026-09-01T15:00:00Z"]
        ]);
        assert.equal(replay.acquisitions.length, 1);
    });

    test("a cash merger closes the lots for the cash, realizing against their basis", () => {
        const replay = replayFills(fillsOf([fill("1", "TGT", "buy", 10, 40, "2026-09-01T15:00:00Z")]), [], "2026-10-28", {
            actions: [action({ type: "CASH_MERGER", symbol: "TGT", cash: 50, exDate: "2026-09-10" })]
        });
        assert.equal(replay.realized, 100);
        assert.equal(replay.lots.length, 0);
        assert.deepEqual(replay.disposals.map(({ kind, qty, lotPrice, price }) => [kind, qty, lotPrice, price]), [["merger", 10, 40, 50]]);
    });

    test("an action after today, or on lots bought on its effective date, isn't applied", () => {
        const replay = replayFills(fillsOf([
            fill("1", "AAA", "buy", 10, 100, "2026-09-10T15:00:00Z"),
            fill("2", "CCC", "buy", 10, 100, "2026-09-01T15:00:00Z")
        ]), [], "2026-10-28", {
            actions: [action({ type: "STOCK_MERGER", symbol: "AAA", newSymbol: "BBB", factor: 2, exDate: "2026-09-10" }), action({ type: "WORTHLESS", symbol: "CCC", exDate: "2026-11-02" })]
        });
        assert.deepEqual(replay.lots.map(({ symbol, qty }) => [symbol, qty]).sort(), [["AAA", 10], ["CCC", 10]]);
    });

    test("a loss washed by shares bought under the stock's new symbol", () => {
        const activities = [
            fill("1", "OLD", "buy", 10, 20, "2026-03-02T15:00:00Z"),
            fill("2", "OLD", "sell", 10, 15, "2026-03-10T15:00:00Z"),
            fill("3", "NEW", "buy", 10, 16, "2026-03-20T15:00:00Z")
        ];
        const replay = replayFills(fillsOf(activities), [], "2026-10-28", { actions: [action({ type: "NAME_CHANGE", symbol: "OLD", newSymbol: "NEW", exDate: "2026-03-12" })] });
        const report = taxReportOf({ replay, activities, year: 2026, prices: new Map([["NEW", 18]]), now: "2026-10-28T00:00:00Z" });
        assert.equal(report.form1099B.sales[0].washDisallowed, 50);
    });

    test("an expired contract closes at nothing", () => {
        const activities = [
            fill("1", "F261120C00012000", "buy", 1, 2, "2026-09-03T15:00:00Z"),
            cash("2", "OPEXP", 0, "2026-11-20", { symbol: "F261120C00012000", qty: "-1", created_at: "2026-11-20T21:45:00Z" })
        ];
        const replay = replayFills(fillsOf(activities), [], "2026-11-21", { optionEvents: optionEventsOf(activities) });
        assert.equal(replay.realized, -200);
        assert.equal(replay.lots.length, 0);
        assert.deepEqual(replay.disposals.map(({ qty, lotPrice, price }) => [qty, lotPrice, price]), [[100, 2, 0]]);
    });

    test("an exercised call closes without P&L and puts its premium into the shares' basis", () => {
        const activities = [
            fill("1", "F261120C00012000", "buy", 2, 2, "2026-09-03T15:00:00Z"),
            cash("2", "OPEXC", 0, "2026-10-01", { symbol: "F261120C00012000", qty: "-1", created_at: "2026-10-01T15:00:00Z" }),
            fill("3", "F", "buy", 100, 12, "2026-10-01T15:00:00Z", "")
        ];
        const replay = replayFills(fillsOf(activities), [], "2026-10-28", { optionEvents: optionEventsOf(activities) });
        assert.equal(replay.realized, 0);
        assert.equal(replay.disposals.length, 0, "an exercise isn't a disposal");
        assert.deepEqual(replay.lots.map(({ symbol, qty, price }) => [symbol, qty, price]), [["F261120C00012000", 1, 2], ["F", 100, 14]]);
    });

    test("an assigned short put buys the shares at the strike less the premium", () => {
        const activities = [
            fill("1", "F261120P00012000", "sell", 1, 1.5, "2026-09-03T15:00:00Z"),
            cash("2", "OPASN", 0, "2026-10-01", { symbol: "F261120P00012000", qty: "1", created_at: "2026-10-01T20:45:00Z" }),
            fill("3", "F", "buy", 100, 12, "2026-10-01T20:45:00Z", "")
        ];
        const replay = replayFills(fillsOf(activities), [], "2026-10-28", { optionEvents: optionEventsOf(activities) });
        assert.deepEqual(replay.lots.map(({ symbol, qty, price }) => [symbol, qty, price]), [["F", 100, 10.5]]);
    });
});

describe("rows", () => {
    test("trades newest first with their realized P&L and settlement", () => {
        const fills = fillsOf([fill("1", "AAPL", "buy", 2, 100, "2026-10-26T15:00:00Z"), fill("2", "AAPL", "sell", 2, 105, "2026-10-27T15:00:00Z")]);
        const rows = transactionRowsOf(fills, replayFills(fills, [], "2026-10-28"), "user_1");
        assert.deepEqual(rows.map(({ id, type, total, realized_pnl, settle_date, order_id }) => [id, type, total, realized_pnl, settle_date, order_id]), [
            ["2", "SELL", "210.00", 10, "2026-10-28", "order-2"],
            ["1", "BUY", "200.00", null, "2026-10-27", "order-1"]
        ]);
    });

    test("cash activities by kind, without fills or corporate actions that moved no cash", () => {
        const rows = cashRowsOf([
            cash("1", "CSD", 1000, "2026-10-01"), cash("2", "CSW", -200, "2026-10-02"), cash("3", "DIV", 12.5, "2026-10-03", { symbol: "F" }), cash("4", "DIVNRA", -3, "2026-10-03"),
            cash("5", "FEE", -0.02, "2026-10-04"), cash("6", "INT", -4.1, "2026-10-31"), cash("7", "WH", -3, "2026-10-03"), cash("8", "MA", 0, "2026-10-05"), cash("9", "MA", 50, "2026-10-05"),
            fill("10", "F", "buy", 1, 10, "2026-10-05T15:00:00Z"), cash("11", "JNLC", 5, "2026-10-06")
        ], "user_1");
        assert.deepEqual(rows.map(({ id, type, amount }) => `${id} ${type} ${amount}`), [
            "1 DEPOSIT 1000.00", "2 WITHDRAW 200.00", "3 DIVIDEND_IN 12.50", "4 DIVIDEND_OUT 3.00", "5 FEE 0.02", "6 INTEREST 4.10", "7 WITHHOLDING 3.00", "9 CORPORATE_ACTION_IN 50.00"
        ]);
        assert.equal(rows[2].ticker, "F");
    });

    test("positions are signed", () => {
        assert.deepEqual(toAppPositions([{ symbol: "F", qty: "-3", side: "short", avg_entry_price: "12.5" }, { symbol: "AAPL", qty: "2", side: "long", avg_entry_price: "180" }] as Position[]),
            [{ ticker: "F", quantity: -3, avgCost: 12.5 }, { ticker: "AAPL", quantity: 2, avgCost: 180 }]);
    });
});

describe("the account summary", () => {
    const trade = {
        cash: "-4000.00", pending_transfer_out: "100.00", accrued_fees: "0.03", equity: "6000", maintenance_margin: "3000", initial_margin: "5000", buying_power: "2000",
        regt_buying_power: "1000", non_marginable_buying_power: "500", options_buying_power: "500", multiplier: "2", long_market_value: "10000", short_market_value: "0",
        sma: "1000", cash_withdrawable: "0", shorting_enabled: true, options_approved_level: 2, options_trading_level: 2
    } as unknown as TradeAccount;
    const positions = [{ symbol: "AAPL", qty: "50", side: "long", avg_entry_price: "190", unrealized_pl: "500" }] as Position[];
    const activities = [
        cash("1", "CSD", 9500, "2026-10-01"), fill("2", "AAPL", "buy", 60, 190, "2026-10-26T15:00:00Z"), fill("3", "AAPL", "sell", 10, 200, "2026-10-28T15:00:00Z"),
        cash("4", "DIV", 5, "2026-10-27"), cash("5", "DIVNRA", -1, "2026-10-27")
    ];

    test("the ledger's figures", () => {
        const ledger = ledgerOf({ trade, positions, activities, splits: [], today: "2026-10-28" });
        assert.equal(ledger.totalCash, -4100);
        assert.equal(ledger.pendingTransferOut, 100);
        assert.equal(ledger.realizedPnl, 100);
        assert.equal(ledger.netDividends, 4);
        // Today's sale settles tomorrow
        assert.equal(ledger.unsettledProceeds, 2000);
        assert.equal(ledger.accruedFees, 0.03);
    });

    test("Alpaca's trading account as the app's Account", () => {
        const ledger = ledgerOf({ trade, positions, activities, splits: [], today: "2026-10-28" });
        const account = accountSummary({ trade, positions, configurations: { max_margin_multiplier: "4" }, ledger, marginRate: 0.065 });
        assert.equal(account.equity, 6000);
        assert.equal(account.excessLiquidity, 3000);
        assert.equal(account.debitBalance, 4100);
        assert.equal(account.multiplier, 2);
        assert.equal(account.maxMultiplier, 4);
        assert.equal(account.unrealizedPnl, 500);
        assert.equal(account.optionsLevel, 2);
        assert.equal(account.shortingBlockedReason, null);
        assert.equal(account.marginStatus, "ok");
        assert.deepEqual(account.positions, [{ ticker: "AAPL", quantity: 50 }]);
        assert.equal(accountSummary({ trade: { ...trade, shorting_enabled: false }, positions, configurations: {}, ledger, marginRate: 0.065 }).shortingEnabled, false);
    });
});

describe("the tax report", () => {
    test("a loss repurchased within 30 days is a wash sale, its loss added to the new lot", () => {
        const activities = [
            fill("1", "F", "buy", 10, 20, "2026-03-02T15:00:00Z"),
            fill("2", "F", "sell", 10, 15, "2026-03-10T15:00:00Z"),
            fill("3", "F", "buy", 10, 16, "2026-03-20T15:00:00Z"),
            cash("4", "DIV", 30, "2026-06-01"), cash("5", "WH", -7.2, "2026-06-01", { description: "Backup withholding on dividends" })
        ];
        const replay = replayFills(fillsOf(activities), [], "2026-10-28");
        const report = taxReportOf({ replay, activities, year: 2026, prices: new Map([["F", 18]]), now: "2026-10-28T00:00:00Z" });
        const [sale] = report.form1099B.sales;
        assert.equal(sale.washDisallowed, 50);
        assert.equal(sale.gain, 0);
        assert.equal(report.form1099DIV.ordinaryDividends, 30);
        assert.equal(report.form1099DIV.federalWithheld, 7.2);
        const [lot] = report.unrealized;
        assert.equal(lot.costBasis, 210);
        assert.equal(lot.washAdjustment, 50);
        assert.equal(lot.unrealized, -30);
    });

    test("a split after a loss sale counts the shares sold in today's terms", () => {
        // 10 sold at a $50 loss, a 2-for-1 split, then 20 bought: all 20 replace the 10 sold (20 today)
        const activities = [
            fill("1", "F", "buy", 10, 20, "2026-03-02T15:00:00Z"),
            fill("2", "F", "sell", 10, 15, "2026-03-10T15:00:00Z"),
            fill("3", "F", "buy", 20, 8, "2026-03-20T15:00:00Z")
        ];
        const replay = replayFills(fillsOf(activities), [{ ticker: "F", exDate: "2026-03-16", factor: 2 }], "2026-10-28");
        const report = taxReportOf({ replay, activities, year: 2026, prices: new Map([["F", 9]]), now: "2026-10-28T00:00:00Z" });
        assert.equal(report.form1099B.sales[0].washDisallowed, 50);
        assert.deepEqual(report.unrealized.map(lot => [lot.qty, lot.costBasis, lot.washAdjustment]), [[20, 210, 50]], "one group: every share replaced one sold");
    });
});

describe("an order's fills", () => {
    test("follow the orders it replaced", async () => {
        const orders: Record<string, Partial<Order>> = { b: { id: "b", replaces: "a" }, a: { id: "a", replaces: null } };
        const fills: Record<string, Activity[]> = { a: [fill("f1", "F", "buy", 1, 10, "2026-10-27T15:00:00Z", "a")], b: [fill("f2", "F", "buy", 2, 11, "2026-10-28T15:00:00Z", "b")] };
        const broker = {
            getOrder: async (_: string, id: string) => orders[id] as Order,
            listActivities: async (_: string, query: { order_id?: string; activity_types?: string }) => {
                assert.equal(query.activity_types, "FILL");
                return fills[query.order_id!] ?? [];
            }
        };
        const rows = await orderFillRows(broker as never, "acct", "b", "user_1");
        assert.deepEqual(rows.map(({ id, order_id }) => `${id}:${order_id}`), ["f2:b", "f1:a"]);
    });
});
