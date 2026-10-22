import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser, type TickerContext } from "@/lib/server/errors";

// Whether the user watches a ticker (no prices, so it costs no Alpha Vantage call)
export const GET = withUser(async (request, { params }: TickerContext, userId) => {
    const ticker = (await params).ticker.toUpperCase();
    const { rowCount } = await pool.query("SELECT 1 FROM watchlist WHERE user_id = $1 AND ticker = $2", [userId, ticker]);
    return NextResponse.json({ ticker, watched: (rowCount ?? 0) > 0 });
});

// Stop watching a ticker
export const DELETE = withUser(async (request, { params }: TickerContext, userId) => {
    const ticker = (await params).ticker.toUpperCase();
    await pool.query("DELETE FROM watchlist WHERE user_id = $1 AND ticker = $2", [userId, ticker]);
    return NextResponse.json({ ticker, watched: false });
});
