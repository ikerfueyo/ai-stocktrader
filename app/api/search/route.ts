import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { filterTradable } from "@/lib/server/assets";
import { searchSymbols } from "@/lib/server/marketData";
import type { SymbolMatch } from "@/lib/types";

// Get tradable stocks matching ?q= (a symbol or company name), at most 8 (Alpha Vantage SYMBOL_SEARCH, cached 24 hours), leaving out
// ETFs, funds and anything else outside the universe
export const GET = withUser(async (request) => {
    const query = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 40);
    if (!query) return NextResponse.json<SymbolMatch[]>([]);
    const equities = (await searchSymbols(query)).filter(({ type }) => type === "Equity");
    const tradable = new Set(await filterTradable(equities.map(({ symbol }) => symbol)));
    return NextResponse.json<SymbolMatch[]>(equities.filter(({ symbol }) => tradable.has(symbol)).slice(0, 8));
});
