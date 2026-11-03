// The simulator's position accounting: open tax lots, closed first in, first out (FIFO, the IRS default), splits applied to the
// lots, and positions derived from them. Pure, so it can be unit tested; ./positions.ts stores the lots.
import type { Position } from "../../../types";

const round9 = (value: number) => Math.round(value * 1e9) / 1e9;

// An open lot: shares bought (long) or sold short (short) together, at one price per share, with when they were acquired
export interface Lot {
    id: string;
    symbol: string;
    side: "long" | "short";
    qty: number;
    price: number;
    acquiredAt: string;
}

export interface FillInput {
    side: "buy" | "sell";
    qty: number;
    price: number;
    at: string;
}

// The part of a lot a fill closed, and what it realized: (fill price - lot price) x shares for a long, the reverse for a short
export interface Closing {
    lotId: string;
    qty: number;
    price: number;
    realized: number;
}

// Applies a fill to a symbol's open lots, oldest first: a buy closes short lots and a sell long ones, FIFO, and whatever's left
// opens a new lot on the fill's side (newLotId). Returns the open lots after the fill, what it closed, the lot it opened, and the
// P&L it realized. A symbol has lots on one side only.
export const applyFill = (lots: Lot[], fill: FillInput, newLotId: string, symbol: string): { lots: Lot[]; closings: Closing[]; opened: Lot | null; realized: number } => {
    const closingSide = fill.side === "buy" ? "short" : "long";
    const ordered = [...lots].sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.id.localeCompare(b.id));
    const remaining: Lot[] = [];
    const closings: Closing[] = [];
    let left = fill.qty;
    for (const lot of ordered) {
        if (lot.side !== closingSide || left <= 0) {
            remaining.push(lot);
            continue;
        }
        const qty = Math.min(lot.qty, left);
        const realized = (lot.side === "long" ? fill.price - lot.price : lot.price - fill.price) * qty;
        closings.push({ lotId: lot.id, qty: round9(qty), price: lot.price, realized });
        left = round9(left - qty);
        const rest = round9(lot.qty - qty);
        if (rest > 0) remaining.push({ ...lot, qty: rest });
    }
    const opened = left > 0 ? { id: newLotId, symbol, side: fill.side === "buy" ? "long" as const : "short" as const, qty: left, price: fill.price, acquiredAt: fill.at } : null;
    return {
        lots: opened ? [...remaining, opened] : remaining,
        closings,
        opened,
        realized: closings.reduce((sum, { realized }) => sum + realized, 0)
    };
};

// A split of factor new shares per old share (below 1 for a reverse split): each lot's shares multiply and its price divides, so its
// cost basis doesn't change. Fractional shares are kept.
export const applySplit = (lots: Lot[], factor: number): Lot[] =>
    lots.map(lot => ({ ...lot, qty: round9(lot.qty * factor), price: lot.price / factor }));

// One position per symbol from the open lots: quantity signed (negative for a short) and the average price of the lots still open
export const positionsFromLots = (lots: Lot[]): Position[] => {
    const bySymbol = new Map<string, { qty: number; cost: number; side: "long" | "short" }>();
    for (const lot of lots) {
        const position = bySymbol.get(lot.symbol) ?? { qty: 0, cost: 0, side: lot.side };
        position.qty += lot.qty;
        position.cost += lot.qty * lot.price;
        bySymbol.set(lot.symbol, position);
    }
    return [...bySymbol.entries()].filter(([, { qty }]) => round9(qty) > 0).map(([ticker, { qty, cost, side }]) => ({
        ticker,
        quantity: Math.round((side === "long" ? qty : -qty) * 1e6) / 1e6,
        avgCost: cost / qty
    }));
};

// Whether a lot closed on closedAt was held long enough for a long-term gain: more than a year (the day after its anniversary)
export const isLongTerm = (acquiredAt: string, closedAt: string): boolean => {
    const acquired = new Date(acquiredAt);
    const anniversary = new Date(Date.UTC(acquired.getUTCFullYear() + 1, acquired.getUTCMonth(), acquired.getUTCDate()));
    return closedAt.slice(0, 10) > anniversary.toISOString().slice(0, 10);
};
