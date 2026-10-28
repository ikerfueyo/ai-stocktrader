// Alpaca's corporate actions (GET /v1/corporate-actions in the Market Data API) as the app stores them in corporate_actions. Pure, so
// it can be unit tested. Splits and cash dividends come from Alpha Vantage, so only the rest is taken: stock dividends, cash, stock
// and mixed mergers, spinoffs, symbol changes and worthless removals. Unit splits, redemptions and rights aren't for common stocks.
import type { components } from "./generated/marketDataApi";

type Schemas = components["schemas"];

export interface StoredCorporateAction {
    ticker: string;
    type: "STOCK_DIVIDEND" | "CASH_MERGER" | "STOCK_MERGER" | "MIXED_MERGER" | "SPINOFF" | "NAME_CHANGE" | "WORTHLESS";
    // The effective date
    exDate: string;
    paymentDate: string | null;
    // New shares per old share, and cash per share
    factor: number | null;
    amount: number | null;
    newTicker: string | null;
}

type Loose<T> = { [K in keyof T]?: unknown };

const day = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;

export const fromAlpacaCorporateActions = (actions: Partial<Record<keyof Schemas["corporate_actions"], Loose<Record<string, unknown>>[]>>): StoredCorporateAction[] => {
    const stored: StoredCorporateAction[] = [];
    const add = (action: StoredCorporateAction | null) => {
        if (action && action.ticker && action.exDate) stored.push(action);
    };
    for (const row of actions.stock_dividends ?? []) {
        const rate = num(row.rate);
        add(rate === null ? null : { ticker: text(row.symbol)!, type: "STOCK_DIVIDEND", exDate: day(row.ex_date)!, paymentDate: day(row.payable_date), factor: 1 + rate, amount: null, newTicker: null });
    }
    for (const row of actions.cash_mergers ?? []) {
        add({ ticker: text(row.acquiree_symbol)!, type: "CASH_MERGER", exDate: day(row.effective_date)!, paymentDate: day(row.payable_date), factor: null, amount: num(row.rate), newTicker: null });
    }
    for (const row of actions.stock_mergers ?? []) {
        const acquirer = num(row.acquirer_rate);
        const acquiree = num(row.acquiree_rate);
        add(acquirer === null || !acquiree ? null : {
            ticker: text(row.acquiree_symbol)!, type: "STOCK_MERGER", exDate: day(row.effective_date)!, paymentDate: day(row.payable_date),
            factor: acquirer / acquiree, amount: null, newTicker: text(row.acquirer_symbol)
        });
    }
    for (const row of actions.stock_and_cash_mergers ?? []) {
        const acquirer = num(row.acquirer_rate);
        const acquiree = num(row.acquiree_rate);
        add(acquirer === null || !acquiree ? null : {
            ticker: text(row.acquiree_symbol)!, type: "MIXED_MERGER", exDate: day(row.effective_date)!, paymentDate: day(row.payable_date),
            factor: acquirer / acquiree, amount: num(row.cash_rate), newTicker: text(row.acquirer_symbol)
        });
    }
    for (const row of actions.spin_offs ?? []) {
        const source = num(row.source_rate);
        const rate = num(row.new_rate);
        add(rate === null || !source ? null : {
            ticker: text(row.source_symbol)!, type: "SPINOFF", exDate: day(row.ex_date)!, paymentDate: day(row.payable_date),
            factor: rate / source, amount: null, newTicker: text(row.new_symbol)
        });
    }
    for (const row of actions.name_changes ?? []) {
        const from = text(row.old_symbol);
        const to = text(row.new_symbol);
        // A CUSIP-only change keeps the symbol: nothing to do here
        add(from && to && from !== to ? { ticker: from, type: "NAME_CHANGE", exDate: day(row.process_date)!, paymentDate: null, factor: null, amount: null, newTicker: to } : null);
    }
    for (const row of actions.worthless_removals ?? []) {
        add({ ticker: text(row.symbol)!, type: "WORTHLESS", exDate: day(row.process_date)!, paymentDate: null, factor: null, amount: null, newTicker: null });
    }
    return stored;
};
