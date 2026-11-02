import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { HttpError, withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";

interface DocumentContext {
    params: Promise<{ id: string }>;
}

// A document to view or print (the simulator's are HTML pages to print or save as PDF; a trade_confirmation_json is JSON), shown in
// the browser rather than downloaded
export const GET = withUser(async (request, { params }: DocumentContext, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) throw new HttpError("Document not found", 404);
    const { contentType, body } = await getBroker().downloadDocument(accountId, (await params).id);
    return new NextResponse(Buffer.from(body), { headers: { "Content-Type": contentType, "Content-Disposition": "inline", "Cache-Control": "private, no-store" } });
});
