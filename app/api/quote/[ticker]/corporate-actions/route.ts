import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { loadCorporateActions } from "@/lib/server/corporateActions";
import { describe, type CorporateActionType } from "@/lib/server/broker/sim/corporateActions";
import type { CorporateActionEntry } from "@/lib/types";

// A stock's corporate actions from a year back on, upcoming ones included, newest first: splits and dividends (Alpha Vantage) and
// stock dividends, mergers, spinoffs, symbol changes and removals (Alpaca, with keys), as the symbol or the one it leads to. Fetches
// the ticker's first if it was never fetched.
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    await loadCorporateActions([ticker]);
    const { rows } = await pool.query<{ ticker: string; type: CorporateActionType; ex_date: string; payment_date: string | null; factor: string | null; amount: string | null; new_ticker: string | null }>(
        `SELECT ticker, "type", ex_date::text, payment_date::text, factor, amount, new_ticker FROM corporate_actions
         WHERE (ticker = $1 OR new_ticker = $1) AND ex_date >= CURRENT_DATE - 365 ORDER BY ex_date DESC LIMIT 20`,
        [ticker]
    );
    return NextResponse.json<CorporateActionEntry[]>(rows.map(row => ({
        type: row.type, ticker: row.ticker, newTicker: row.new_ticker, exDate: row.ex_date, paymentDate: row.payment_date,
        description: describe({ type: row.type, symbol: row.ticker, newSymbol: row.new_ticker, factor: row.factor === null ? null : Number(row.factor), cash: row.amount === null ? null : Number(row.amount), exDate: row.ex_date })
    })));
});
