import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { fetchQuotes } from "@/lib/server/alphaVantage";
import { peekTickerVerdict } from "@/lib/server/analysis";
import type { WatchlistItem } from "@/lib/types";

const TICKER = /^[A-Z0-9.\-]{1,15}$/;

// Get the user's watchlist, newest first, with each ticker's price and previous close (fetched together, cached 60s) and its AI
// verdict when one is already cached (watching never triggers an analysis)
export const GET = withUser(async (request, context, userId) => {
    const { rows } = await pool.query<{ ticker: string; added_at: Date }>(
        "SELECT ticker, added_at FROM watchlist WHERE user_id = $1 ORDER BY added_at DESC", [userId]
    );
    const quotes = await Promise.allSettled(fetchQuotes(rows.map(({ ticker }) => ticker)));
    const items = await Promise.all(rows.map(async ({ ticker, added_at }, index): Promise<WatchlistItem> => {
        const quote = quotes[index];
        return {
            ticker, addedAt: added_at.toISOString(),
            price: quote.status === "fulfilled" ? quote.value.price : null,
            previousClose: quote.status === "fulfilled" ? quote.value.previousClose : null,
            verdict: await peekTickerVerdict(ticker),
            error: quote.status === "rejected" ? quote.reason.message : null
        };
    }));
    return NextResponse.json(items);
});

// Watch a ticker: body { ticker }. Watching one already on the list does nothing.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { ticker?: unknown } | null;
    const ticker = String(body?.ticker ?? "").toUpperCase();
    if (!TICKER.test(ticker)) throw new HttpError("A valid ticker is required", 400);
    await pool.query("INSERT INTO watchlist (user_id, ticker) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, ticker]);
    return NextResponse.json({ ticker, watched: true });
});
