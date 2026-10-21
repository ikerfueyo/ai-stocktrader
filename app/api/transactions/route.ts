import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { withUser } from "@/lib/server/errors";
import type { TransactionRow } from "@/lib/types";

// Get all of the user's transactions
export const GET = withUser(async (request, context, userId) => {
    const allTransactions = await pool.query<TransactionRow>('SELECT * FROM transactions WHERE user_id = $1 ORDER BY "date" DESC, id DESC', [userId]);
    return NextResponse.json(allTransactions.rows);
});
