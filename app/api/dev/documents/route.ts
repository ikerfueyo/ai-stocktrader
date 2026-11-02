import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";
import { brokerMode } from "@/lib/server/broker";
import { generatePreliminaryDocuments } from "@/lib/server/broker/sim/documents";

// Development only: preliminary versions of this month's statement, today's trade confirmation and a year's consolidated 1099 (body
// { year }, default this year), made again on each call, so documents can be seen without waiting for them. 404 in production.
export const POST = withUser(async (request, context, userId) => {
    if (process.env.NODE_ENV === "production") throw new HttpError("Not found", 404);
    if (brokerMode() !== "sim") throw new HttpError("Preliminary documents are the simulator's; Alpaca makes its own", 400);
    const accountId = await ledgerAccountId(userId);
    if (!accountId) throw new HttpError("Open an account first", 403);
    const body = await request.json().catch(() => null) as { year?: unknown } | null;
    const year = typeof body?.year === "number" && Number.isInteger(body.year) ? body.year : new Date().getFullYear();
    await generatePreliminaryDocuments(accountId, year);
    return NextResponse.json({ year });
});
