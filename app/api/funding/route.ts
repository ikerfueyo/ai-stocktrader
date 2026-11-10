import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { fundingTerms } from "@/lib/server/funding";
import type { FundingTerms } from "@/lib/types";

// Get the broker's transfer limits and fees, for the deposit and withdraw forms (the broker enforces them), and how banks are linked:
// through Plaid with Alpaca when Plaid is configured (the simulator takes routing and account numbers only)
export const GET = withUser(async () => NextResponse.json<FundingTerms>(fundingTerms()));
