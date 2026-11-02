import { NextResponse } from "next/server";
import { requireTradableStock } from "@/lib/server/assets";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { fetchQuotes } from "@/lib/server/marketData";
import { peekTickerVerdict } from "@/lib/server/analysis";
import type { WatchlistItem } from "@/lib/types";

const TICKER = /^[A-Z0-9.\-]{1,15}$/;
// Every watched ticker costs a quote on each watchlist load, so the list is capped
const MAX_WATCHED = 50;

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

// Watch a ticker: body { ticker }. Watching one already on the list does nothing; a new one past MAX_WATCHED is a 400.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { ticker?: unknown } | null;
    const ticker = String(body?.ticker ?? "").toUpperCase();
    if (!TICKER.test(ticker)) throw new HttpError("A valid ticker is required", 400);
    await requireTradableStock(ticker);
    // Inserted only while the list has room; a ticker already on it counts as watched either way
    const { rows: [{ watched }] } = await pool.query<{ watched: boolean }>(
        `WITH added AS (
             INSERT INTO watchlist (user_id, ticker)
             SELECT $1, $2 WHERE (SELECT count(*) FROM watchlist WHERE user_id = $1) < $3
             ON CONFLICT DO NOTHING RETURNING ticker
         )
         SELECT EXISTS (SELECT 1 FROM added) OR EXISTS (SELECT 1 FROM watchlist WHERE user_id = $1 AND ticker = $2) AS watched`,
        [userId, ticker, MAX_WATCHED]
    );
    if (!watched) throw new HttpError(`The watchlist holds up to ${MAX_WATCHED} tickers; remove one first`, 400);
    return NextResponse.json({ ticker, watched: true });
});
