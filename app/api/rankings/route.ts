import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getRankings } from "@/lib/server/analysis";

// Get up to 5 buy and 5 sell stocks from market news sentiment, each confirmed by its own analysis (Alpha Vantage + OpenAI APIs)
export const GET = withUser(async () => NextResponse.json(await getRankings()));
