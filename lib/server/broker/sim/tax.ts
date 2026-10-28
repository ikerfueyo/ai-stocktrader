// Tax reporting for the simulator's accounts: each closing of a lot as a 1099-B sale (proceeds, cost basis, gain or loss, short or long
// term, every one covered since the lots carry their basis), wash sales within the account, and the year's 1099-B, 1099-DIV and
// 1099-INT figures. Pure, so it can be unit tested; ./documents.ts assembles them from the ledger.
//   Wash sales (IRS Publication 550): a loss on a sale of shares is disallowed when shares of the same security are bought within 30
//   days before or after it; the disallowed loss is added to the replacement shares' basis, and their holding period includes the
//   sold shares'. As a broker reports it, this is within the account and by symbol, for long sales; each replacement share absorbs
//   one share's loss. Short sales are reported short term, without wash sale adjustments (a labeled limitation).
//   1099-DIV: every dividend is ordinary (qualified status isn't known); dividends charged to shorts aren't income, and stock
//   dividends aren't taxable. 1099-INT: interest paid to the account (none: the simulator only charges margin interest).

const DAY_MS = 86400000;
export const WASH_WINDOW_DAYS = 30;
export const BACKUP_WITHHOLDING_RATE = 0.24;
// Forms are issued for reportable amounts of $10 or more (1099-B for any sale)
export const REPORTING_THRESHOLD = 10;

export interface Acquisition {
    lotId: string;
    symbol: string;
    side: "long" | "short";
    // Shares, in today's terms (after splits)
    qty: number;
    acquiredAt: string;
}

export interface Disposal {
    id: string;
    lotId: string;
    symbol: string;
    side: "long" | "short";
    qty: number;
    // The lot's price per share (what was paid, or for a short what it sold for) and what it was closed at
    lotPrice: number;
    price: number;
    acquiredAt: string;
    closedAt: string;
    // How it was disposed of: a sale (a fill), a cash merger, cash in lieu, or a worthless removal
    kind: "sale" | "merger" | "cash_in_lieu" | "worthless";
}

export interface ReportedSale extends Disposal {
    proceeds: number;
    costBasis: number;
    // Loss disallowed by the wash sale rule (added back to the gain)
    washDisallowed: number;
    // Proceeds less basis, plus any disallowed loss
    gain: number;
    term: "short" | "long";
    // The acquisition date the holding period runs from (earlier than acquiredAt when a wash sale's holding period carried over)
    dateAcquired: string;
    covered: true;
}

export interface LotAdjustment {
    // Disallowed losses added to the lot's basis, in total
    basis: number;
    // Days of holding period carried over from the shares it replaced
    carriedDays: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY_MS).toISOString();

// Held more than a year is long term (counted from the day after acquisition, so a year and a day)
export const termOf = (acquiredAt: string, closedAt: string): "short" | "long" => {
    const acquired = new Date(acquiredAt);
    const anniversary = new Date(Date.UTC(acquired.getUTCFullYear() + 1, acquired.getUTCMonth(), acquired.getUTCDate()));
    return Date.parse(closedAt.slice(0, 10)) > anniversary.getTime() ? "long" : "short";
};

// Every disposal as a reported sale, oldest first, with the wash sales found among them, and what wash sales added to each lot
export const reportSales = (acquisitions: Acquisition[], disposals: Disposal[]): { sales: ReportedSale[]; adjustments: Map<string, LotAdjustment> } => {
    const adjustments = new Map<string, LotAdjustment>();
    const capacity = new Map(acquisitions.map(({ lotId, qty }) => [lotId, qty]));
    const lotQty = new Map(acquisitions.map(({ lotId, qty }) => [lotId, qty]));
    const sales: ReportedSale[] = [];
    for (const disposal of [...disposals].sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.id.localeCompare(b.id))) {
        const adjustment = adjustments.get(disposal.lotId);
        const extraPerShare = adjustment && lotQty.get(disposal.lotId) ? adjustment.basis / lotQty.get(disposal.lotId)! : 0;
        const dateAcquired = adjustment ? shiftDays(disposal.acquiredAt, adjustment.carriedDays) : disposal.acquiredAt;
        const long = disposal.side === "long";
        const proceeds = cents(disposal.qty * (long ? disposal.price : disposal.lotPrice));
        const costBasis = cents(disposal.qty * (long ? disposal.lotPrice + extraPerShare : disposal.price));
        let gain = cents(proceeds - costBasis);
        let washDisallowed = 0;
        if (long && gain < 0 && disposal.kind === "sale") {
            const lossPerShare = -gain / disposal.qty;
            let left = disposal.qty;
            const replacements = acquisitions
                .filter(({ lotId, symbol, side, acquiredAt }) => lotId !== disposal.lotId && symbol === disposal.symbol && side === "long"
                    && Math.abs(daysBetween(disposal.closedAt, acquiredAt)) <= WASH_WINDOW_DAYS && (capacity.get(lotId) ?? 0) > 1e-9)
                .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
            const heldDays = Math.max(0, daysBetween(dateAcquired, disposal.closedAt));
            for (const replacement of replacements) {
                if (left <= 1e-9) break;
                const used = Math.min(left, capacity.get(replacement.lotId)!);
                capacity.set(replacement.lotId, capacity.get(replacement.lotId)! - used);
                const added = used * lossPerShare;
                const existing = adjustments.get(replacement.lotId) ?? { basis: 0, carriedDays: 0 };
                adjustments.set(replacement.lotId, { basis: existing.basis + added, carriedDays: Math.max(existing.carriedDays, heldDays) });
                washDisallowed += added;
                left -= used;
            }
            washDisallowed = cents(washDisallowed);
            gain = cents(gain + washDisallowed);
        }
        sales.push({
            ...disposal, proceeds, costBasis, washDisallowed, gain, covered: true, dateAcquired,
            term: long ? termOf(dateAcquired, disposal.closedAt) : "short"
        });
    }
    return { sales, adjustments };
};

export interface Form1099B {
    sales: ReportedSale[];
    // Totals per term
    totals: Record<"short" | "long", { proceeds: number; costBasis: number; washDisallowed: number; gain: number }>;
    federalWithheld: number;
}

export interface TaxYearInput {
    year: number;
    sales: ReportedSale[];
    // Dividends received (positive) and charged to shorts (negative), each with its date
    dividends: { date: string; amount: number }[];
    // Interest paid to the account
    interest: { date: string; amount: number }[];
    // Backup withholding, on dividends or on proceeds
    withholding: { date: string; amount: number; on: "dividends" | "proceeds" | "interest" }[];
}

export interface TaxYear {
    year: number;
    form1099B: Form1099B;
    form1099DIV: { ordinaryDividends: number; qualifiedDividends: number; federalWithheld: number; required: boolean };
    form1099INT: { interestIncome: number; federalWithheld: number; required: boolean };
}

const inYear = (date: string, year: number) => date.slice(0, 4) === String(year);

// The year's 1099 figures: sales closed in the year (each with its wash sale adjustments), dividends received, interest paid and the
// backup withholding on each
export const taxYear = ({ year, sales, dividends, interest, withholding }: TaxYearInput): TaxYear => {
    const yearSales = sales.filter(({ closedAt }) => inYear(closedAt, year));
    const totals = { short: { proceeds: 0, costBasis: 0, washDisallowed: 0, gain: 0 }, long: { proceeds: 0, costBasis: 0, washDisallowed: 0, gain: 0 } };
    for (const sale of yearSales) {
        const total = totals[sale.term];
        total.proceeds = cents(total.proceeds + sale.proceeds);
        total.costBasis = cents(total.costBasis + sale.costBasis);
        total.washDisallowed = cents(total.washDisallowed + sale.washDisallowed);
        total.gain = cents(total.gain + sale.gain);
    }
    const withheld = (on: TaxYearInput["withholding"][number]["on"]) => cents(withholding.filter(entry => entry.on === on && inYear(entry.date, year)).reduce((sum, { amount }) => sum + amount, 0));
    const ordinaryDividends = cents(dividends.filter(({ date, amount }) => amount > 0 && inYear(date, year)).reduce((sum, { amount }) => sum + amount, 0));
    const interestIncome = cents(interest.filter(({ date, amount }) => amount > 0 && inYear(date, year)).reduce((sum, { amount }) => sum + amount, 0));
    const divWithheld = withheld("dividends");
    const intWithheld = withheld("interest");
    return {
        year,
        form1099B: { sales: yearSales, totals, federalWithheld: withheld("proceeds") },
        form1099DIV: { ordinaryDividends, qualifiedDividends: 0, federalWithheld: divWithheld, required: ordinaryDividends >= REPORTING_THRESHOLD || divWithheld > 0 },
        form1099INT: { interestIncome, federalWithheld: intWithheld, required: interestIncome >= REPORTING_THRESHOLD || intWithheld > 0 }
    };
};

// Backup withholding on an amount paid (dividends, or a sale's gross proceeds), rounded to the cent
export const backupWithholding = (amount: number) => amount > 0 ? cents(amount * BACKUP_WITHHOLDING_RATE) : 0;

// IRAs: Form 1099-R for distributions and Form 5498 for contributions and the year-end value. An IRA's trades, dividends and interest
// aren't reported (no 1099-B, DIV or INT), and it isn't subject to backup withholding.

export interface IraDistribution {
    date: string;
    gross: number;
    fedWithheld: number;
    stateWithheld: number;
    // The 1099-R's box 7 distribution code (lib/ira.ts's DISTRIBUTION_REASONS)
    code: string;
}

export interface Form1099RLine {
    code: string;
    // Box 1
    gross: number;
    // Box 2a: the taxable amount, or null when it isn't determined (box 2b: a Roth's non-qualified distribution, whose taxable part
    // depends on the owner's contributions)
    taxable: number | null;
    taxableNotDetermined: boolean;
    // Boxes 4 and 14
    fedWithheld: number;
    stateWithheld: number;
}

export interface Form1099R {
    year: number;
    // The IRA/SEP/SIMPLE box: checked for a traditional IRA
    traditional: boolean;
    // One form per distribution code
    lines: Form1099RLine[];
    // Filed for distributions of $10 or more
    required: boolean;
}

export const form1099R = ({ year, subType, distributions }: { year: number; subType: "traditional" | "roth"; distributions: IraDistribution[] }): Form1099R => {
    const lines = new Map<string, Form1099RLine>();
    for (const distribution of distributions.filter(({ date }) => inYear(date, year))) {
        const line = lines.get(distribution.code) ?? { code: distribution.code, gross: 0, taxable: 0, taxableNotDetermined: false, fedWithheld: 0, stateWithheld: 0 };
        line.gross = cents(line.gross + distribution.gross);
        line.fedWithheld = cents(line.fedWithheld + distribution.fedWithheld);
        line.stateWithheld = cents(line.stateWithheld + distribution.stateWithheld);
        lines.set(distribution.code, line);
    }
    for (const line of lines.values()) {
        // A traditional IRA's distributions are taxable in full (no basis tracked); a qualified Roth distribution isn't taxable; other
        // Roth distributions are left for the owner to work out
        if (subType === "traditional") line.taxable = line.gross;
        else if (line.code === "Q") line.taxable = 0;
        else {
            line.taxable = null;
            line.taxableNotDetermined = true;
        }
    }
    const all = [...lines.values()];
    return { year, traditional: subType === "traditional", lines: all, required: all.reduce((sum, { gross }) => sum + gross, 0) >= REPORTING_THRESHOLD };
};

export interface Form5498 {
    year: number;
    // Box 1 (traditional) or box 10 (Roth): the contributions for the tax year, including those made by the next April 15
    contributions: number;
    traditional: boolean;
    // Box 5: the account's value at the year's end
    fairMarketValue: number;
    // Box 11: a required minimum distribution is due for the next year
    rmdNextYear: boolean;
}

// The age required minimum distributions start (SECURE 2.0): 73 for those born 1951 to 1959, 75 from 1960, 72 before
export const rmdAge = (dateOfBirth: string): number => {
    const year = Number(dateOfBirth.slice(0, 4));
    return year >= 1960 ? 75 : year >= 1951 ? 73 : 72;
};

export const form5498 = ({ year, subType, contributions, fairMarketValue, dateOfBirth }: { year: number; subType: "traditional" | "roth"; contributions: { taxYear: number; amount: number }[]; fairMarketValue: number; dateOfBirth: string }): Form5498 => ({
    year,
    contributions: cents(contributions.filter(({ taxYear }) => taxYear === year).reduce((sum, { amount }) => sum + amount, 0)),
    traditional: subType === "traditional",
    fairMarketValue: cents(fairMarketValue),
    // Roth owners take no required distributions in their lifetime
    rmdNextYear: subType === "traditional" && year + 1 - Number(dateOfBirth.slice(0, 4)) >= rmdAge(dateOfBirth)
});
