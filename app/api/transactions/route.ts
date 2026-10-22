import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getAccount } from "@/lib/server/portfolio";
import type { TradeHistoryRow } from "@/lib/types";

// Get all of the user's trades, newest first, each with the P&L it realized (replayed with splits, at average cost)
export const GET = withUser(async (request, context, userId) => {
    const { transactions, realized } = await getAccount(userId);
    const rows: TradeHistoryRow[] = transactions.map((row, index) => ({ ...row, realized_pnl: realized[index] }));
    // id breaks ties for rows migrated from the old DATE column, which all sit at midnight
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime() || b.id - a.id);
    return NextResponse.json(rows);
});
