import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";
import { iraOverview } from "@/lib/server/ira";
import type { IraOverview } from "@/lib/types";

// The user's IRA contributions and limits per open tax year, the IRA kinds they have, and the active account's IRA details
export const GET = withUser(async (request, context, userId) => NextResponse.json<IraOverview>(await iraOverview(userId, await ledgerAccountId(userId))));
