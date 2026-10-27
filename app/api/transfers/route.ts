import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { loadCashActivity } from "@/lib/server/portfolio";
import type { CashActivityRow } from "@/lib/types";

// Get the user's cash ledger, newest first: the broker's deposits, withdrawals and fees as they posted (a deposit as it's
// credited: up to the instant limit at once, the rest when it settles; a withdrawal when it leaves), and dividends. Transfers in
// progress are at /api/accounts/[id]/transfers.
export const GET = withUser(async (request, context, userId) => NextResponse.json<CashActivityRow[]>((await loadCashActivity(userId)).reverse()));
