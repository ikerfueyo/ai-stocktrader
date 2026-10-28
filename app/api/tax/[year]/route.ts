import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { ledgerAccountId } from "@/lib/server/portfolio";
import { accountTaxYear, unrealizedLots } from "@/lib/server/broker/sim/documents";
import type { TaxReport } from "@/lib/types";

interface YearContext {
    params: Promise<{ year: string }>;
}

// The realized gains and losses report for a tax year (each sale with its basis, wash sale adjustment, term and gain, the totals and
// the year's dividends, interest and withholding: the consolidated 1099's figures so far) and the open lots' unrealized gains, with
// their tax basis and holding period
export const GET = withUser(async (request, { params }: YearContext, userId) => {
    const year = Number((await params).year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError("year must be a year", 400);
    const accountId = await ledgerAccountId(userId);
    if (!accountId) return NextResponse.json<TaxReport | null>(null);
    const [{ allSales, ...figures }, lots] = await Promise.all([accountTaxYear(accountId, year), unrealizedLots(accountId)]);
    void allSales;
    return NextResponse.json<TaxReport>({ ...figures, unrealized: lots });
});
