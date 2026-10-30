// The regulatory fees passed through on trades, by the date they take effect, as Alpaca charges them: accrued with each fill and
// deducted at the end of the day, rounded up to the cent, as FEE activities (REG for the SEC fee, TAF, CAT, and for options ORF and OCC).
// Commissions are $0, on stocks and options.
// Pure, so it can be unit tested. Check the figures against the sources when they change; each rate lists the one it came from.

interface DatedRate<T> {
    from: string;
    rate: T;
}

// SEC Section 31: dollars per dollar of sale proceeds (sales only; Alpaca's fee schedule, above, has $0.0000206)
// https://www.sec.gov/rules-regulations/fee-rate-advisories (FY2025 $27.80 per million; $0 from Oct 1, 2025; $20.60 per million from
// Apr 4, 2026 until 60 days after the FY2027 appropriation)
const SEC_RATES: DatedRate<number>[] = [
    { from: "2024-05-22", rate: 27.80 / 1e6 },
    { from: "2025-10-01", rate: 0 },
    { from: "2026-04-04", rate: 20.60 / 1e6 }
];

// FINRA Trading Activity Fee: dollars per share sold, capped per trade (sales only)
// https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule, SR-FINRA-2026-021 ($0 for trades
// Oct 1 to Dec 31, 2026) and SR-FINRA-2026-020 (the 2026 rates kept from 2027 through 2028)
const TAF_RATES: DatedRate<{ perShare: number; cap: number }>[] = [
    { from: "2025-01-01", rate: { perShare: 0.000166, cap: 8.30 } },
    { from: "2026-01-01", rate: { perShare: 0.000195, cap: 9.79 } },
    { from: "2026-10-01", rate: { perShare: 0, cap: 0 } },
    { from: "2027-01-01", rate: { perShare: 0.000195, cap: 9.79 } }
];

// Consolidated Audit Trail fee: dollars per executed equivalent share, on buys and sells (an option contract is 100 of them). $0.000003
// in Alpaca's fee schedule (files.alpaca.markets/disclosures/library/BrokFeeSched.pdf, revised Oct 12, 2026); before it, CAT Fee
// 2026-1's reported $0.000001 (https://catnmsplan.com, fee alert 2026-1).
const CAT_RATES: DatedRate<number>[] = [
    { from: "2026-05-01", rate: 0.000001 },
    { from: "2026-10-12", rate: 0.000003 }
];

// Options, per contract, as in Alpaca's fee schedule (above): the options regulatory fee (ORF, $0.015) and the OCC clearing fee
// ($0.025) on buys and sells; FINRA's TAF on contracts sold ($0 in the schedule; $0.00329 from FINRA's filing, with the share rate's $0
// from Oct 1 to Dec 31, 2026); the SEC fee on sale proceeds as for stocks; CAT on 100 executed equivalent shares a contract.
const ORF_RATES: DatedRate<number>[] = [{ from: "2026-01-01", rate: 0.015 }];
const OCC_RATES: DatedRate<number>[] = [{ from: "2026-01-01", rate: 0.025 }];
const OPTION_TAF_RATES: DatedRate<number>[] = [
    { from: "2026-01-01", rate: 0.00329 },
    { from: "2026-10-01", rate: 0 },
    { from: "2027-01-01", rate: 0.00329 }
];

const rateOn = <T>(rates: DatedRate<T>[], date: string): T | null => {
    let current: T | null = null;
    for (const { from, rate } of rates) if (from <= date) current = rate;
    return current;
};

export interface FeeAccrual {
    type: "REG" | "TAF" | "CAT" | "ORF" | "OCC";
    amount: number;
}

// The fees a fill accrues on its trade date ("YYYY-MM-DD"), unrounded; the ones that are zero are left out. multiplier is the contract's
// shares (100 for an option, whose qty is in contracts and price per share).
export const feesFor = ({ side, qty, price, date, multiplier = 1 }: { side: "buy" | "sell"; qty: number; price: number; date: string; multiplier?: number }): FeeAccrual[] => {
    const fees: FeeAccrual[] = [];
    if (multiplier > 1) {
        if (side === "sell") {
            const sec = (rateOn(SEC_RATES, date) ?? 0) * qty * price * multiplier;
            if (sec > 0) fees.push({ type: "REG", amount: sec });
            const taf = (rateOn(OPTION_TAF_RATES, date) ?? 0) * qty;
            if (taf > 0) fees.push({ type: "TAF", amount: taf });
        }
        for (const [type, rates] of [["ORF", ORF_RATES], ["OCC", OCC_RATES]] as const) {
            const amount = (rateOn(rates, date) ?? 0) * qty;
            if (amount > 0) fees.push({ type, amount });
        }
        const cat = (rateOn(CAT_RATES, date) ?? 0) * qty * multiplier;
        if (cat > 0) fees.push({ type: "CAT", amount: cat });
        return fees;
    }
    if (side === "sell") {
        const sec = (rateOn(SEC_RATES, date) ?? 0) * qty * price;
        if (sec > 0) fees.push({ type: "REG", amount: sec });
        const taf = rateOn(TAF_RATES, date);
        if (taf && taf.perShare > 0) fees.push({ type: "TAF", amount: Math.min(taf.perShare * qty, taf.cap) });
    }
    const cat = (rateOn(CAT_RATES, date) ?? 0) * qty;
    if (cat > 0) fees.push({ type: "CAT", amount: cat });
    return fees;
};

// A day's accrued fees of one type, as deducted: rounded up to the cent (a tenth of a millionth of slack, for float noise)
export const roundFeeUp = (amount: number): number => amount <= 0 ? 0 : Math.ceil(amount * 100 - 1e-7) / 100;

export const FEE_DESCRIPTIONS: Record<FeeAccrual["type"], string> = {
    REG: "SEC Section 31 fee",
    TAF: "FINRA trading activity fee",
    CAT: "Consolidated audit trail fee",
    ORF: "Options regulatory fee",
    OCC: "OCC clearing fee"
};
