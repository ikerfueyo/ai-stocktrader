import "server-only";
import { brokerMode } from "./broker/broker";
import { getPlaid } from "./broker/alpaca";
import { FUNDING_LIMITS, TRANSFER_FEES } from "./broker/sim/funding";
import type { FundingTerms } from "../types";

// The broker in use's transfer terms, shown by the deposit and withdraw forms and used to check a withdrawal with its fee (the broker
// enforces them). With the simulator, its own limits and fees (lib/server/broker/sim/funding.ts). With Alpaca: its fee schedule's $15
// outgoing domestic wire and $25 ACH return (revised Oct 12, 2026; ALPACA_WIRE_FEE and ALPACA_ACH_RETURN_FEE when it changes), the
// daily ACH limit from ALPACA_ACH_DAILY_LIMIT (default 50000, not yet confirmed by Alpaca), and no instant credit (accounts are opened
// with allow_instant_ach false).
const amount = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const fundingTerms = (env: Record<string, string | undefined> = process.env): FundingTerms => {
    if (brokerMode() === "sim") {
        return {
            minimum: FUNDING_LIMITS.minimum, dailyAch: FUNDING_LIMITS.dailyAch, instant: FUNDING_LIMITS.instant,
            wireFee: TRANSFER_FEES.wireOutDomestic, achReturnFee: TRANSFER_FEES.achReturn, plaid: false, simulated: true
        };
    }
    return {
        minimum: 1, dailyAch: amount(env.ALPACA_ACH_DAILY_LIMIT, 50000), instant: 0,
        wireFee: amount(env.ALPACA_WIRE_FEE, 15), achReturnFee: amount(env.ALPACA_ACH_RETURN_FEE, 25),
        plaid: getPlaid() !== null, simulated: false
    };
};
