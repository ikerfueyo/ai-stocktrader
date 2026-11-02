// Tax reporting for the simulator's accounts: each closing of a lot as a 1099-B sale (proceeds, cost basis, gain or loss, short or long
// term, every one covered since the lots carry their basis), wash sales within the account, and the year's 1099-B, 1099-DIV and
// 1099-INT figures. Pure, so it can be unit tested; ./documents.ts assembles them from the ledger.
//   Wash sales (IRS Publication 550): a loss on a sale of shares is disallowed when shares of the same security are bought within 30
//   days before or after it; the disallowed loss is added to the replacement shares' basis, and their holding period includes the
//   sold shares'. As a broker reports it (IRC 6045(g)(2)(B)(ii)), this is within the account and by symbol, each replacement share
//   absorbing one share's loss, oldest first. Only the replaced shares are adjusted: a lot's washed shares are kept apart from the
//   rest, sold first (their holding period starts earlier), and a sale spanning both is reported as one 1099-B line for each. A
//   replacement must still be held at the loss sale (or bought after it), so the disallowed loss always lands on shares whose basis
//   is still to be reported; shares bought and sold before the loss sale aren't counted (a labeled choice: counting them would mean
//   restating a sale already reported, whose new loss could wash back into the shares being sold). Shares from the same purchase as
//   the shares sold don't replace them (Rev. Rul. 56-602).
//   Short sales: a loss on covering a short is disallowed when another short of the stock is opened within 30 days before or after
//   (Treas. Reg. 1.1091-1(g)), and added to that short's cost of covering. A long sale as the replacement isn't covered. A short
//   sale's gain or loss is short term, as the shares that close it were just bought (IRC 1233(b)).
//   1099-DIV: every dividend is ordinary (qualified status isn't known); dividends charged to shorts aren't income, and stock
//   dividends aren't taxable. 1099-INT: interest paid to the account (none: the simulator only charges margin interest).

import { rmdDue } from "../../../ira";

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
    // The shares in today's terms (after the splits and other share changes since the sale), as acquisitions are; qty when the same
    sharesNow?: number;
    // The symbol wash sales match acquisitions on (the stock's symbol now, after a symbol change); symbol when the same
    matchSymbol?: string;
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

// Shares of a lot that replaced shares sold at a loss: how many (in today's terms), the disallowed loss added to their basis in total
// (for a short, to its cost of covering), and the days of holding period carried over from the shares they replaced
export interface WashedShares {
    qty: number;
    basis: number;
    carriedDays: number;
}

const EPSILON = 1e-9;
const cents = (value: number) => Math.round(value * 100) / 100;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY_MS).toISOString();

// Held more than a year is long term (counted from the day after acquisition, so a year and a day)
export const termOf = (acquiredAt: string, closedAt: string): "short" | "long" => {
    const acquired = new Date(acquiredAt);
    const anniversary = new Date(Date.UTC(acquired.getUTCFullYear() + 1, acquired.getUTCMonth(), acquired.getUTCDate()));
    return Date.parse(closedAt.slice(0, 10)) > anniversary.getTime() ? "long" : "short";
};

// Every disposal as reported sales, oldest first (more than one when it sold both washed shares and others, ids after the first
// suffixed #2, #3...), with the wash sales found among them, and each lot's open shares that wash sales adjusted
export const reportSales = (acquisitions: Acquisition[], disposals: Disposal[]): { sales: ReportedSale[]; adjustments: Map<string, WashedShares[]> } => {
    // Each lot's shares not yet disposed of, in today's terms: those wash sales adjusted, in the order they're sold, and the rest
    const washed = new Map<string, WashedShares[]>();
    const plain = new Map(acquisitions.map(({ lotId, qty }) => [lotId, qty]));
    const sales: ReportedSale[] = [];
    for (const disposal of [...disposals].sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.id.localeCompare(b.id))) {
        const long = disposal.side === "long";
        const sharesNow = disposal.sharesNow ?? disposal.qty;
        // The shares sold: the lot's washed shares first, then the rest (and any its acquisition doesn't account for)
        const pieces: WashedShares[] = [];
        let left = sharesNow;
        const groups = washed.get(disposal.lotId) ?? [];
        while (left > EPSILON && groups.length > 0) {
            const group = groups[0];
            const used = Math.min(left, group.qty);
            const basis = group.basis * used / group.qty;
            pieces.push({ qty: used, basis, carriedDays: group.carriedDays });
            group.qty -= used;
            group.basis -= basis;
            if (group.qty <= EPSILON) groups.shift();
            left -= used;
        }
        if (left > EPSILON) {
            if (plain.has(disposal.lotId)) plain.set(disposal.lotId, Math.max(0, plain.get(disposal.lotId)! - left));
            pieces.push({ qty: left, basis: 0, carriedDays: 0 });
        }
        // Disallows a loss on the shares sold (in today's terms) by the replacement shares found, oldest first: other lots of the stock
        // on the same side opened within 30 days before or after the sale, with shares still open that haven't replaced others
        const washLoss = (shares: number, loss: number, heldDays: number) => {
            const lossPerShare = loss / shares;
            let unreplaced = shares;
            let disallowed = 0;
            const replacements = acquisitions
                .filter(({ lotId, symbol, side, acquiredAt }) => lotId !== disposal.lotId && symbol === (disposal.matchSymbol ?? disposal.symbol) && side === disposal.side
                    && Math.abs(daysBetween(disposal.closedAt, acquiredAt)) <= WASH_WINDOW_DAYS && (plain.get(lotId) ?? 0) > EPSILON)
                .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.lotId.localeCompare(b.lotId));
            for (const replacement of replacements) {
                if (unreplaced <= EPSILON) break;
                const used = Math.min(unreplaced, plain.get(replacement.lotId)!);
                plain.set(replacement.lotId, plain.get(replacement.lotId)! - used);
                const lotGroups = washed.get(replacement.lotId) ?? [];
                // The washed shares with the earliest holding period are sold first
                lotGroups.push({ qty: used, basis: used * lossPerShare, carriedDays: heldDays });
                lotGroups.sort((a, b) => b.carriedDays - a.carriedDays);
                washed.set(replacement.lotId, lotGroups);
                disallowed += used * lossPerShare;
                unreplaced -= used;
            }
            return cents(disallowed);
        };
        // Proceeds and cost apportioned by shares, the last piece taking what rounding leaves
        const totalProceeds = cents(disposal.qty * (long ? disposal.price : disposal.lotPrice));
        const totalCost = cents(disposal.qty * (long ? disposal.lotPrice : disposal.price));
        let proceedsLeft = totalProceeds;
        let costLeft = totalCost;
        pieces.forEach((piece, i) => {
            const last = i === pieces.length - 1;
            const proceeds = last ? cents(proceedsLeft) : cents(totalProceeds * piece.qty / sharesNow);
            const cost = last ? cents(costLeft) : cents(totalCost * piece.qty / sharesNow);
            proceedsLeft -= proceeds;
            costLeft -= cost;
            const costBasis = cents(cost + piece.basis);
            const dateAcquired = piece.carriedDays > 0 ? shiftDays(disposal.acquiredAt, piece.carriedDays) : disposal.acquiredAt;
            let gain = cents(proceeds - costBasis);
            let washDisallowed = 0;
            if (gain < 0 && disposal.kind === "sale") {
                washDisallowed = washLoss(piece.qty, -gain, long ? Math.max(0, daysBetween(dateAcquired, disposal.closedAt)) : 0);
                gain = cents(gain + washDisallowed);
            }
            sales.push({
                ...disposal, id: i === 0 ? disposal.id : `${disposal.id}#${i + 1}`, qty: pieces.length === 1 ? disposal.qty : disposal.qty * piece.qty / sharesNow,
                proceeds, costBasis, washDisallowed, gain, covered: true, dateAcquired, term: long ? termOf(dateAcquired, disposal.closedAt) : "short"
            });
        });
    }
    const adjustments = new Map([...washed].flatMap(([lotId, groups]) => {
        const open = groups.filter(({ qty }) => qty > EPSILON).map(group => ({ ...group }));
        return open.length > 0 ? [[lotId, open] as const] : [];
    }));
    return { sales, adjustments };
};

// A corporate action that changed an account's shares, as the tax rules follow them
export interface ShareChange {
    type: string;
    ticker: string;
    newTicker: string | null;
    exDate: string;
    factor: number | null;
    // A mixed merger fully taxable (its lots closed and new ones opened) rather than a reorganization
    taxable: boolean | null;
}

// What shares of a symbol held on a day (Eastern) are now, through the changes that took effect after it, in date order: the factor
// to today's shares (splits and stock dividends multiply them; a stock merger, or a mixed merger taken as a reorganization, moves them
// to the acquirer at its ratio) and the symbol they go by. renamesOnly follows symbol changes alone, which keep the same security.
export const sharesSince = (changes: ShareChange[], symbol: string, day: string, renamesOnly = false): { factor: number; symbol: string } => {
    let factor = 1;
    let current = symbol;
    for (const change of [...changes].sort((a, b) => a.exDate.localeCompare(b.exDate))) {
        if (change.exDate <= day || change.ticker !== current) continue;
        if (change.type === "NAME_CHANGE" && change.newTicker) current = change.newTicker;
        if (renamesOnly) continue;
        if (change.type === "SPLIT" || change.type === "STOCK_DIVIDEND") factor *= change.factor ?? 1;
        else if ((change.type === "STOCK_MERGER" || (change.type === "MIXED_MERGER" && !change.taxable)) && change.newTicker) {
            factor *= change.factor ?? 1;
            current = change.newTicker;
        }
    }
    return { factor, symbol: current };
};

export interface UnrealizedLot {
    id: string;
    symbol: string;
    side: "long" | "short";
    // In the lot's units (contracts for an option)
    qty: number;
    acquiredAt: string;
    // The acquisition date the holding period runs from
    dateAcquired: string;
    price: number;
    // What the shares cost, wash sale losses added; for a short, what it sold for, less the wash sale losses its covering will carry
    costBasis: number;
    washAdjustment: number;
    marketValue: number | null;
    unrealized: number | null;
    term: "short" | "long";
}

// An open lot's unrealized gain as the tax report shows it: a row for each group of its shares wash sales adjusted (ids after the
// first suffixed #2, #3...), then one for the rest. washed comes from reportSales' adjustments, in shares; multiplier is the contract's.
export const unrealizedRows = (
    lot: { id: string; symbol: string; side: "long" | "short"; qty: number; price: number; acquiredAt: string; multiplier: number },
    washed: WashedShares[] = [], marketPrice: number | null, now: string
): UnrealizedLot[] => {
    const groups: WashedShares[] = [];
    let left = lot.qty * lot.multiplier;
    for (const group of washed) {
        if (left <= EPSILON) break;
        const qty = Math.min(left, group.qty);
        groups.push({ qty, basis: group.basis * qty / group.qty, carriedDays: group.carriedDays });
        left -= qty;
    }
    if (left > EPSILON || groups.length === 0) groups.push({ qty: Math.max(0, left), basis: 0, carriedDays: 0 });
    return groups.map((group, i) => {
        const wash = cents(group.basis);
        const own = group.qty * lot.price;
        const costBasis = cents(lot.side === "long" ? own + group.basis : own - group.basis);
        const marketValue = marketPrice === null ? null : cents(group.qty * marketPrice);
        const dateAcquired = group.carriedDays > 0 ? shiftDays(lot.acquiredAt, group.carriedDays) : lot.acquiredAt;
        return {
            id: i === 0 ? lot.id : `${lot.id}#${i + 1}`, symbol: lot.symbol, side: lot.side, qty: groups.length === 1 ? lot.qty : group.qty / lot.multiplier,
            acquiredAt: lot.acquiredAt, dateAcquired, price: lot.price, costBasis, washAdjustment: wash, marketValue,
            unrealized: marketValue === null ? null : cents(lot.side === "long" ? marketValue - costBasis : costBasis - marketValue),
            term: lot.side === "long" ? termOf(dateAcquired, now) : "short"
        };
    });
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

export const form5498 = ({ year, subType, contributions, fairMarketValue, dateOfBirth }: { year: number; subType: "traditional" | "roth"; contributions: { taxYear: number; amount: number }[]; fairMarketValue: number; dateOfBirth: string }): Form5498 => ({
    year,
    contributions: cents(contributions.filter(({ taxYear }) => taxYear === year).reduce((sum, { amount }) => sum + amount, 0)),
    traditional: subType === "traditional",
    fairMarketValue: cents(fairMarketValue),
    // Roth owners take no required distributions in their lifetime
    rmdNextYear: rmdDue(year + 1, subType, dateOfBirth) !== null
});

export interface RmdNotice {
    // The year the distribution is for, and whether it's the owner's first (due by April 1 of the next year; later ones by December 31)
    year: number;
    firstYear: boolean;
    deadline: string;
    // The account's value at the prior year's end, which the amount is worked out from
    priorYearEndValue: number;
}

// The notice a traditional IRA's owner of RMD age gets by January 31 of the year a distribution is due (Alpaca sends one, without the
// amount); none when the account had no value at the prior year's end
export const rmdNotice = ({ year, subType, dateOfBirth, priorYearEndValue }: { year: number; subType: "traditional" | "roth"; dateOfBirth: string; priorYearEndValue: number }): RmdNotice | null => {
    const due = rmdDue(year, subType, dateOfBirth);
    return due && priorYearEndValue > 0 ? { ...due, priorYearEndValue: cents(priorYearEndValue) } : null;
};
