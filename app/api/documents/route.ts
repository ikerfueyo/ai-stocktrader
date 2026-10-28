import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";
import type { BrokerDocument } from "@/lib/types";

const TYPES = ["account_application", "account_statement", "tax_statement", "trade_confirmation", "trade_confirmation_json"];

// The account's documents (Alpaca's AccountDocument), newest first: ?type= one of trade_confirmation, trade_confirmation_json,
// account_statement, tax_statement, account_application; ?year= dated in a year. The broker makes the due ones first.
export const GET = withUser(async (request, context, userId) => {
    const accountId = await ledgerAccountId(userId);
    if (!accountId) return NextResponse.json<BrokerDocument[]>([]);
    const params = request.nextUrl.searchParams;
    const type = params.get("type");
    const year = Number(params.get("year"));
    const documents = await getBroker().listDocuments(accountId, {
        ...(Number.isInteger(year) && year > 2000 ? { start: `${year}-01-01`, end: `${year}-12-31` } : {}),
        ...(type && TYPES.includes(type) ? { type } : {})
    } as Parameters<ReturnType<typeof getBroker>["listDocuments"]>[1]);
    return NextResponse.json<BrokerDocument[]>(documents);
});
