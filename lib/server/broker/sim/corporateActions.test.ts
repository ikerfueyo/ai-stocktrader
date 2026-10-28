import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { adjustOrder, applyActionToLots, roundDownToTick, type AdjustableOrder, type CorporateAction } from "./corporateActions";
import { fromAlpacaCorporateActions } from "../../marketData/corporateActions";
import type { Lot } from "./ledger";

const lot = (id: string, qty: number, price: number, acquiredAt = "2026-01-05", side: "long" | "short" = "long", symbol = "OLD"): Lot => ({ id, symbol, side, qty, price, acquiredAt });
const action = (overrides: Partial<CorporateAction>): CorporateAction => ({ type: "SPLIT", symbol: "OLD", newSymbol: null, factor: null, cash: null, exDate: "2026-10-28", ...overrides });
const noPrices = { symbol: null, newSymbol: null };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);

describe("Corporate actions on lots", () => {
    test("a forward split multiplies shares and divides the price, keeping the basis", () => {
        const effect = applyActionToLots([lot("a", 10, 300), lot("b", 5, 330, "2026-02-01")], action({ factor: 3 }), { prices: noPrices });
        assert.deepEqual(effect.updates, [{ id: "a", symbol: "OLD", qty: 30, price: 100 }, { id: "b", symbol: "OLD", qty: 15, price: 110 }]);
        assert.deepEqual(effect.activities.map(({ type, subType, qty }) => [type, subType, qty]), [["SPLIT", "FSPLIT", 30]]);
        assert.equal(effect.cash, 0);
    });

    test("a reverse split keeps a fractional share, or pays cash in lieu of it", () => {
        const kept = applyActionToLots([lot("a", 15, 2)], action({ factor: 0.1 }), { prices: { symbol: 20, newSymbol: null } });
        assert.deepEqual(kept.updates, [{ id: "a", symbol: "OLD", qty: 1.5, price: 20 }]);
        assert.equal(kept.activities[0].subType, "RSPLIT");
        const paid = applyActionToLots([lot("a", 15, 2)], action({ factor: 0.1 }), { prices: { symbol: 22, newSymbol: null }, cashInLieu: true });
        assert.deepEqual(paid.updates, [{ id: "a", symbol: "OLD", qty: 1, price: 20 }]);
        assert.deepEqual(paid.activities.map(({ type, qty, netAmount }) => [type, qty, netAmount]), [["SPLIT", -13.5, 0], ["CIL", -0.5, 110]]);
        assert.equal(paid.cash, 110);
        close(paid.realized, (220 - 20) * 0.5);
    });

    test("a stock dividend posts DIV (SDIV) and spreads the basis", () => {
        const effect = applyActionToLots([lot("a", 100, 50)], action({ type: "STOCK_DIVIDEND", factor: 1.05 }), { prices: noPrices });
        assert.equal(effect.updates[0].qty, 105);
        // Prices are kept to 6 decimals, so the basis is right to a tenth of a cent
        assert.ok(Math.abs(effect.updates[0].price * 105 - 5000) < 0.001);
        assert.deepEqual(effect.activities.map(({ type, subType, qty }) => [type, subType, qty]), [["DIV", "SDIV", 5]]);
    });

    test("a cash merger closes the shares for the cash, realizing against the basis", () => {
        const effect = applyActionToLots([lot("a", 10, 40), lot("b", 10, 60)], action({ type: "CASH_MERGER", cash: 55 }), { prices: noPrices });
        assert.deepEqual(effect.updates.map(({ qty }) => qty), [0, 0]);
        assert.equal(effect.cash, 1100);
        close(effect.realized, 10 * 15 - 10 * 5);
        assert.deepEqual(effect.activities.map(({ type, subType, qty, netAmount }) => [type, subType, qty, netAmount]), [["MA", "CMA", -20, 1100]]);
        // A short pays the cash
        const short = applyActionToLots([lot("s", 10, 60, "2026-01-05", "short")], action({ type: "CASH_MERGER", cash: 55 }), { prices: noPrices });
        assert.equal(short.cash, -550);
        close(short.realized, 50);
    });

    test("a stock merger moves the lots to the acquirer, keeping their dates and basis", () => {
        const effect = applyActionToLots([lot("a", 10, 40)], action({ type: "STOCK_MERGER", newSymbol: "NEW", factor: 0.5 }), { prices: noPrices });
        assert.deepEqual(effect.updates, [{ id: "a", symbol: "NEW", qty: 5, price: 80 }]);
        assert.deepEqual(effect.activities.map(({ subType, symbol, qty }) => [subType, symbol, qty]), [["SMA", "OLD", -10], ["SMA", "NEW", 5]]);
    });

    test("a mixed merger splits the basis between the new shares and the cash by market value", () => {
        // 1 new share worth $30 and $10 cash per old share: 75% of the basis stays in the shares
        const effect = applyActionToLots([lot("a", 100, 20)], action({ type: "MIXED_MERGER", newSymbol: "NEW", factor: 1, cash: 10 }), { prices: { symbol: null, newSymbol: 30 } });
        assert.deepEqual(effect.updates, [{ id: "a", symbol: "NEW", qty: 100, price: 15 }]);
        assert.equal(effect.cash, 1000);
        close(effect.realized, 100 * (10 - 5));
        assert.deepEqual(effect.activities.map(({ tag, qty, netAmount }) => [tag, qty, netAmount]), [["removed", -100, 0], ["received", 100, 0], ["cash", 0, 1000]]);
    });

    test("a spinoff adds the new company's lots with the source dates and a market-value share of the basis", () => {
        // 0.5 new shares worth $20 each per $90 share: the new shares take 10 / 100 of the basis
        const effect = applyActionToLots([lot("a", 10, 100, "2025-03-01")], action({ type: "SPINOFF", newSymbol: "SPN", factor: 0.5 }), { prices: { symbol: 90, newSymbol: 20 } });
        assert.deepEqual(effect.updates, [{ id: "a", symbol: "OLD", qty: 10, price: 90 }]);
        assert.deepEqual(effect.opened, [{ sourceLotId: "a", symbol: "SPN", side: "long", qty: 5, price: 20, acquiredAt: "2025-03-01" }]);
        assert.deepEqual(effect.activities.map(({ type, symbol, qty }) => [type, symbol, qty]), [["SPIN", "SPN", 5]]);
        const lieu = applyActionToLots([lot("a", 9, 100)], action({ type: "SPINOFF", newSymbol: "SPN", factor: 0.5 }), { prices: { symbol: 90, newSymbol: 20 }, cashInLieu: true });
        assert.equal(lieu.opened[0].qty, 4);
        assert.deepEqual(lieu.closings.map(({ lotId, openedIndex, qty }) => [lotId, openedIndex, qty]), [[null, 0, 0.5]]);
        assert.equal(lieu.cash, 10);
    });

    test("a symbol change renames the lots; a worthless removal closes them at nothing", () => {
        assert.deepEqual(applyActionToLots([lot("a", 10, 40)], action({ type: "NAME_CHANGE", newSymbol: "NEW" }), { prices: noPrices }).updates, [{ id: "a", symbol: "NEW", qty: 10, price: 40 }]);
        const gone = applyActionToLots([lot("a", 10, 40)], action({ type: "WORTHLESS" }), { prices: noPrices });
        assert.equal(gone.updates[0].qty, 0);
        close(gone.realized, -400);
        assert.deepEqual(gone.activities.map(({ type, subType, qty }) => [type, subType, qty]), [["REORG", "WRM", -10]]);
    });

    test("cash dividends post on their payment date instead", () => {
        assert.deepEqual(applyActionToLots([lot("a", 10, 40)], action({ type: "DIVIDEND", cash: 0.5 }), { prices: noPrices }).activities, []);
    });
});

const order = (overrides: Partial<AdjustableOrder>): AdjustableOrder => ({ side: "buy", type: "limit", timeInForce: "gtc", orderClass: "simple", qty: 10, limitPrice: 100, stopPrice: null, ...overrides });

describe("Corporate actions on open orders", () => {
    test("a forward split adjusts GTC buy limits and sell stops, and cancels the rest", () => {
        assert.deepEqual(adjustOrder(order({}), action({ factor: 4 })), { kind: "replace", qty: 40, limitPrice: 25, stopPrice: null, reason: "CORPORATE_ACTION: OLD 4-for-1 split" });
        assert.deepEqual(adjustOrder(order({ side: "sell", type: "stop", limitPrice: null, stopPrice: 90.01 }), action({ factor: 3 })).kind, "replace");
        assert.equal((adjustOrder(order({ side: "sell", type: "stop", limitPrice: null, stopPrice: 90.01 }), action({ factor: 3 })) as { stopPrice: number }).stopPrice, 30);
        assert.equal(adjustOrder(order({ side: "sell" }), action({ factor: 4 })).kind, "cancel");
        assert.equal(adjustOrder(order({ timeInForce: "day" }), action({ factor: 4 })).kind, "cancel");
        assert.equal((adjustOrder(order({ qty: 7 }), action({ factor: 1.5 })) as { qty: number }).qty, 10, "whole shares, rounded down");
    });

    test("a reverse split cancels them", () => {
        assert.equal(adjustOrder(order({}), action({ factor: 0.1 })).kind, "cancel");
    });

    test("a cash dividend lowers GTC buy limits and sell stops by the dividend", () => {
        assert.deepEqual(adjustOrder(order({ limitPrice: 50.25 }), action({ type: "DIVIDEND", cash: 0.333 })), { kind: "replace", qty: 10, limitPrice: 49.91, stopPrice: null, reason: "CORPORATE_ACTION: OLD $0.333 dividend" });
        assert.equal(adjustOrder(order({ side: "sell" }), action({ type: "DIVIDEND", cash: 0.5 })).kind, "keep", "a sell limit isn't adjusted");
        assert.equal(adjustOrder(order({ timeInForce: "day" }), action({ type: "DIVIDEND", cash: 0.5 })).kind, "keep");
    });

    test("brackets are do-not-reduce, do-not-cancel, unless the security goes away", () => {
        assert.equal(adjustOrder(order({ orderClass: "bracket" }), action({ factor: 4 })).kind, "keep");
        assert.equal(adjustOrder(order({ orderClass: "bracket" }), action({ type: "DIVIDEND", cash: 1 })).kind, "keep");
        assert.equal(adjustOrder(order({ orderClass: "oco" }), action({ type: "CASH_MERGER", cash: 50 })).kind, "cancel");
        for (const type of ["STOCK_MERGER", "MIXED_MERGER", "NAME_CHANGE", "WORTHLESS", "SPINOFF"] as const) {
            assert.equal(adjustOrder(order({}), action({ type, newSymbol: "NEW", factor: 1 })).kind, "cancel", type);
        }
    });

    test("tick rounding", () => {
        assert.equal(roundDownToTick(12.3456), 12.34);
        assert.equal(roundDownToTick(0.123456), 0.1234);
    });
});

describe("Alpaca's corporate actions as stored", () => {
    test("each type maps to a stored action", () => {
        const stored = fromAlpacaCorporateActions({
            stock_dividends: [{ id: "1", symbol: "AAA", cusip: "x", rate: 0.05, process_date: "2026-11-02", ex_date: "2026-11-01", payable_date: "2026-11-03" }],
            cash_mergers: [{ id: "2", acquiree_symbol: "BBB", acquiree_cusip: "x", rate: 42.5, process_date: "2026-11-05", effective_date: "2026-11-04" }],
            stock_mergers: [{ id: "3", acquirer_symbol: "CCC", acquirer_cusip: "x", acquirer_rate: 3, acquiree_symbol: "DDD", acquiree_cusip: "y", acquiree_rate: 2, process_date: "2026-11-06", effective_date: "2026-11-06" }],
            stock_and_cash_mergers: [{ id: "4", acquirer_symbol: "EEE", acquirer_cusip: "x", acquirer_rate: 0.5, acquiree_symbol: "FFF", acquiree_cusip: "y", acquiree_rate: 1, cash_rate: 10, process_date: "2026-11-07", effective_date: "2026-11-07" }],
            spin_offs: [{ id: "5", source_symbol: "GGG", source_cusip: "x", source_rate: 1, new_symbol: "HHH", new_cusip: "y", new_rate: 0.25, process_date: "2026-11-09", ex_date: "2026-11-09" }],
            name_changes: [{ id: "6", old_symbol: "III", old_cusip: "x", new_symbol: "JJJ", new_cusip: "y", process_date: "2026-11-10" }],
            worthless_removals: [{ id: "7", symbol: "KKK", cusip: "x", process_date: "2026-11-11" }]
        });
        assert.deepEqual(stored.map(({ ticker, type, exDate, factor, amount, newTicker }) => [ticker, type, exDate, factor, amount, newTicker]), [
            ["AAA", "STOCK_DIVIDEND", "2026-11-01", 1.05, null, null],
            ["BBB", "CASH_MERGER", "2026-11-04", null, 42.5, null],
            ["DDD", "STOCK_MERGER", "2026-11-06", 1.5, null, "CCC"],
            ["FFF", "MIXED_MERGER", "2026-11-07", 0.5, 10, "EEE"],
            ["GGG", "SPINOFF", "2026-11-09", 0.25, null, "HHH"],
            ["III", "NAME_CHANGE", "2026-11-10", null, null, "JJJ"],
            ["KKK", "WORTHLESS", "2026-11-11", null, null, null]
        ]);
    });
});
