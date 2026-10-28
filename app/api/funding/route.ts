import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { FUNDING_LIMITS, TRANSFER_FEES } from "@/lib/server/broker/sim/funding";
import { brokerMode } from "@/lib/server/broker";
import { getPlaid } from "@/lib/server/broker/alpaca";
import type { FundingTerms } from "@/lib/types";

// Get the broker's transfer limits and fees, for the deposit and withdraw forms (the broker enforces them), and how banks are linked:
// through Plaid with Alpaca when Plaid is configured (the simulator takes routing and account numbers only)
export const GET = withUser(async () => NextResponse.json<FundingTerms>({
    // Alpaca's instant ACH credit is off for the app's accounts (allow_instant_ach false); the limits and fees are the simulator's until
    // Alpaca's are confirmed (docs/going-live.md)
    minimum: FUNDING_LIMITS.minimum, dailyAch: FUNDING_LIMITS.dailyAch, instant: brokerMode() === "sim" ? FUNDING_LIMITS.instant : 0,
    wireFee: TRANSFER_FEES.wireOutDomestic, achReturnFee: TRANSFER_FEES.achReturn,
    plaid: brokerMode() === "alpaca" && getPlaid() !== null, simulated: brokerMode() === "sim"
}));
