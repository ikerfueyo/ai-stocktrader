import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getFills } from "@/lib/server/portfolio";
import type { TradeHistoryRow } from "@/lib/types";

// Get all of the user's trades (fills in the broker's ledger), newest first, each with the P&L it realized against the tax lots it
// closed (FIFO) and when it settles
export const GET = withUser(async (request, context, userId) => NextResponse.json<TradeHistoryRow[]>(await getFills(userId)));
