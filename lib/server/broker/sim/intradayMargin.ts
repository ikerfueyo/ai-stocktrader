// FINRA Rule 4210(d)(2), intraday margin (effective June 4, 2026, replacing the pattern day trader rule; Regulatory Notice 26-10),
// as the simulator applies it to margin accounts. Pure, so it can be unit tested; ./intradayDeficits.ts runs it on the ledger.
//   Intraday margin level (IML, 4210(a)(17)): the cash the account could withdraw while still meeting maintenance margin, that is
//   equity less the maintenance requirement, negative when a deposit would be needed to meet it.
//   IML-reducing transaction (4210(a)(18)): a purchase or sale (an option exercise or assignment included) that lowers the IML.
//   Intraday margin deficit (4210(a)(19)): on a day with any IML-reducing transaction, the absolute value of the most negative IML
//   after one of them. Deposits and withdrawals may be treated as made at the start of the day (4210(d)(2)(B)), which the simulator
//   does: a deposit later that day lowers the earlier levels' deficit.
//   Satisfied when, from the end of that day to the end of a later day, net deposits or other increases to the IML reach it
//   (4210(d)(2)(C)); outstanding until then or the close of the 15th business day after it.
//   90-day restriction (4210(d)(2)(D)): with a practice of not satisfying deficits as promptly as possible, a deficit still unmet at
//   the close of the 5th business day restricts new or larger shorts and debit balances for 90 calendar days after that day, or until
//   it's satisfied, past its 15-day expiry. Deficits within the lesser of 5% of equity or $1,000 never count toward a practice. The
//   rule leaves "practice" to the firm's policies: the simulator counts one when the account has missed the 5th business day on at
//   least SIM_INTRADAY_PRACTICE_MISSES deficits (default 2, this one included) beyond de minimis in the past 12 months.
import { addDays, nextTradingDay } from "../../../marketHours";
import { roundCents } from "../../account";
import type { MarginState } from "./margin";

export const RESTRICTION_BUSINESS_DAYS = 5;
export const EXPIRY_BUSINESS_DAYS = 15;
export const RESTRICTION_CALENDAR_DAYS = 90;
export const DE_MINIMIS_SHARE = 0.05;
export const DE_MINIMIS_CAP = 1000;
export const PRACTICE_WINDOW_DAYS = 365;

// The intraday margin level of the account's figures now
export const intradayMarginLevel = (state: Pick<MarginState, "equity" | "maintenanceMargin">): number => roundCents(state.equity - state.maintenanceMargin);

// Whether a transaction that moved the level from before to after reduced it (by at least a cent)
export const reducesMarginLevel = (before: number, after: number): boolean => after < before - 0.005;

export interface MarginLevel {
    at: Date | string;
    // The level right after the IML-reducing transaction
    level: number;
}

export interface CashFlow {
    at: Date | string;
    // Signed: a deposit positive, a withdrawal negative
    amount: number;
}

const time = (at: Date | string) => new Date(at).getTime();

// The day's deficit: the most negative level after an IML-reducing transaction, with the day's later deposits and withdrawals moved to
// the start of the day (so they count against each level recorded before them); 0 when none is negative
export const dayDeficit = (levels: MarginLevel[], flows: CashFlow[] = []): number => {
    let worst = 0;
    for (const { at, level } of levels) {
        const later = flows.filter(flow => time(flow.at) > time(at)).reduce((sum, flow) => sum + flow.amount, 0);
        worst = Math.min(worst, level + later);
    }
    return worst < 0 ? roundCents(-worst) : 0;
};

// The largest deficit that doesn't count toward a practice: the lesser of 5% of the account's equity or $1,000
export const deMinimisThreshold = (equity: number): number => roundCents(Math.min(Math.max(0, equity) * DE_MINIMIS_SHARE, DE_MINIMIS_CAP));

export const isDeMinimis = (amount: number, equity: number): boolean => amount <= deMinimisThreshold(equity) + 0.005;

// The business day n after dateKey (the NYSE calendar's trading days)
export const businessDaysAfter = (dateKey: string, n: number): string => {
    let day = dateKey;
    for (let i = 0; i < n; i++) day = nextTradingDay(day);
    return day;
};

// When a deficit found on dateKey restricts the account if still unmet (the close of the 5th business day after it) and stops being
// outstanding (the close of the 15th)
export const deficitDeadlines = (dateKey: string) => ({
    restrictOn: businessDaysAfter(dateKey, RESTRICTION_BUSINESS_DAYS),
    expireOn: businessDaysAfter(dateKey, EXPIRY_BUSINESS_DAYS)
});

// Whether a deficit is satisfied: the net deposits since its day ended, or the increase in the level since then, reach it
export const deficitSatisfied = ({ amount, deposits, levelIncrease }: { amount: number; deposits: number; levelIncrease: number }): boolean =>
    Math.max(deposits, levelIncrease) >= amount - 0.005;

// Whether the account has a practice of not satisfying deficits: misses is how many of its deficits beyond de minimis in the past 12
// months were unmet at their 5th business day, this one included
export const isPractice = (misses: number, threshold: number): boolean => misses >= Math.max(1, threshold);

// The last day of a restriction imposed at the close of restrictOn: 90 calendar days after it
export const restrictionEnd = (restrictOn: string): string => addDays(restrictOn, RESTRICTION_CALENDAR_DAYS);

// Whether a restriction is in force on dateKey: until its last day, unless its deficit was satisfied
export const restrictionActive = ({ restrictedUntil, metAt }: { restrictedUntil: string | null; metAt: Date | string | null }, dateKey: string): boolean =>
    restrictedUntil !== null && metAt === null && dateKey <= restrictedUntil;
