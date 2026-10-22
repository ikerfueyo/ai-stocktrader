import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { searchSymbols } from "@/lib/server/alphaVantage";
import type { SymbolMatch } from "@/lib/types";

// Get tickers matching ?q= (a symbol or company name), U.S. listings first, at most 8 (Alpha Vantage SYMBOL_SEARCH, cached 24 hours)
export const GET = withUser(async (request) => {
    const query = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 40);
    if (!query) return NextResponse.json<SymbolMatch[]>([]);
    return NextResponse.json<SymbolMatch[]>((await searchSymbols(query)).slice(0, 8));
});
