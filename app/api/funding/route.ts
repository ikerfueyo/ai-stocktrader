import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { FUNDING_LIMITS, TRANSFER_FEES } from "@/lib/server/broker/sim/funding";
import type { FundingTerms } from "@/lib/types";

// Get the broker's transfer limits and fees, for the deposit and withdraw forms (the broker enforces them)
export const GET = withUser(async () => NextResponse.json<FundingTerms>({
    minimum: FUNDING_LIMITS.minimum, dailyAch: FUNDING_LIMITS.dailyAch, instant: FUNDING_LIMITS.instant,
    wireFee: TRANSFER_FEES.wireOutDomestic, achReturnFee: TRANSFER_FEES.achReturn
}));
