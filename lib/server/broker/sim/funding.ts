// How the simulator moves money the way a broker's bank transfers do: bank links (ACH relationships) and their verification, when
// ACH and wire transfers reach clearing and complete on the Federal Reserve's banking days, which deposits come back as returns
// (NACHA return codes), instant buying power, limits and fees. Pure, so it can be unit tested; ./transfers.ts stores the results.
import { routingValid } from "../../../payments";
import { addDays, easternParts, easternTime } from "../../../marketHours";

// For local testing, SIM_FUNDING_FAST_SECONDS makes each step of a transfer take that many seconds instead of following the banking
// calendar (a deposit then completes after twice that)
const FAST_SECONDS = Number(process.env.SIM_FUNDING_FAST_SECONDS ?? 0);
// The ACH batch cutoff: transfers requested before it on a banking day go to clearing that day
const ACH_CUTOFF = "16:00";
// Outgoing wires requested before this time on a banking day are sent that day
const WIRE_CUTOFF = "15:00";
// When the next banking day's settled ACH funds post
const SETTLEMENT_TIME = "09:00";

export const FUNDING_LIMITS = {
    minimum: 1,
    // Per transfer and per banking day, deposits and withdrawals each (Alpaca sets these per partner; these are the simulator's)
    dailyAch: Number(process.env.SIM_ACH_DAILY_LIMIT ?? 50000),
    // Deposited funds credited at once, before the ACH settles, outstanding at a time (Alpaca's instant funding default)
    instant: Number(process.env.SIM_INSTANT_DEPOSIT_LIMIT ?? 1000)
};

// Transfer fees. Verify against Alpaca's fee schedule (files.alpaca.markets/disclosures/library/BrokFeeSched.pdf) before relying on
// them: ACH is free; the outgoing domestic wire and returned-ACH figures are reported elsewhere and not yet confirmed.
export const TRANSFER_FEES = {
    ach: 0,
    wireOutDomestic: Number(process.env.SIM_WIRE_FEE ?? 25),
    achReturn: Number(process.env.SIM_ACH_RETURN_FEE ?? 25)
};

// The nth (1-based; -1 for the last) weekday (0 Sunday to 6 Saturday) of a month, as "YYYY-MM-DD"
const nthWeekday = (year: number, month: number, weekday: number, n: number): string => {
    if (n > 0) {
        const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        return new Date(Date.UTC(year, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)).toISOString().slice(0, 10);
    }
    const lastDay = new Date(Date.UTC(year, month, 0));
    return new Date(Date.UTC(year, month - 1, lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7))).toISOString().slice(0, 10);
};

// The Federal Reserve's holidays in a year, when ACH and wires don't settle. A holiday on a Sunday is observed on Monday; one on a
// Saturday isn't moved (the Fed is open the Friday before).
export const fedHolidays = (year: number): Set<string> => {
    const fixed = (month: number, day: number) => {
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCDay() === 0 ? addDays(date.toISOString().slice(0, 10), 1) : date.toISOString().slice(0, 10);
    };
    return new Set([
        fixed(1, 1), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1), fixed(6, 19), fixed(7, 4),
        nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2), fixed(11, 11), nthWeekday(year, 11, 4, 4), fixed(12, 25)
    ]);
};

export const isBankingDay = (dateKey: string): boolean => {
    const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !fedHolidays(Number(dateKey.slice(0, 4))).has(dateKey);
};

export const nextBankingDay = (dateKey: string): string => {
    let day = addDays(dateKey, 1);
    while (!isBankingDay(day)) day = addDays(day, 1);
    return day;
};

// The first banking-day moment at or after now at the given Eastern time: today's if it's a banking day and the time hasn't passed
const nextWindow = (now: Date, time: string): Date => {
    const today = easternParts(now).dateKey;
    const todays = easternTime(today, time);
    return isBankingDay(today) && now <= todays ? todays : easternTime(nextBankingDay(today), time);
};

export interface Timeline {
    // When the transfer goes to clearing (an outgoing one leaves the account then), and when it completes
    sentAt: Date;
    completeAt: Date;
}

// An ACH transfer: to clearing at the next batch cutoff, complete the next banking day once it settles
export const achTimeline = (createdAt: Date): Timeline => {
    if (FAST_SECONDS > 0) return { sentAt: new Date(createdAt.getTime() + FAST_SECONDS * 1000), completeAt: new Date(createdAt.getTime() + 2 * FAST_SECONDS * 1000) };
    const sentAt = nextWindow(createdAt, ACH_CUTOFF);
    return { sentAt, completeAt: easternTime(nextBankingDay(easternParts(sentAt).dateKey), SETTLEMENT_TIME) };
};

// An outgoing wire: sent the same banking day before the cutoff (else the next one) and complete within the hour
export const wireTimeline = (createdAt: Date): Timeline => {
    if (FAST_SECONDS > 0) return { sentAt: new Date(createdAt.getTime() + FAST_SECONDS * 1000), completeAt: new Date(createdAt.getTime() + 2 * FAST_SECONDS * 1000) };
    const today = easternParts(createdAt).dateKey;
    const sentAt = isBankingDay(today) && createdAt >= easternTime(today, "08:00") && createdAt <= easternTime(today, WIRE_CUTOFF)
        ? createdAt
        : easternTime(isBankingDay(today) && createdAt < easternTime(today, "08:00") ? today : nextBankingDay(today), "09:00");
    return { sentAt, completeAt: new Date(sentAt.getTime() + 3600000) };
};

// NACHA return codes the simulator uses
export const RETURN_REASONS: Record<string, string> = {
    R01: "Insufficient funds",
    R02: "Account closed",
    R10: "Customer advises not authorized"
};

// Whether a deposit will be returned, triggered by its cents for testing: .01 R01, .02 R02, .10 R10. It's returned 2 banking days
// after it completes (the bank's return window), with the code.
export const plannedReturn = (amount: number, completeAt: Date): { code: string; at: Date } | null => {
    const cents = Math.round(amount * 100) % 100;
    const code = cents === 1 ? "R01" : cents === 2 ? "R02" : cents === 10 ? "R10" : null;
    if (!code) return null;
    if (FAST_SECONDS > 0) return { code, at: new Date(completeAt.getTime() + FAST_SECONDS * 1000) };
    return { code, at: easternTime(nextBankingDay(nextBankingDay(easternParts(completeAt).dateKey)), SETTLEMENT_TIME) };
};

// How much of a deposit to credit at once: up to the instant limit, less what's still outstanding from earlier instant deposits
export const instantAmount = (amount: number, outstandingInstant: number): number =>
    Math.max(0, Math.min(amount, FUNDING_LIMITS.instant - outstandingInstant));

const digits = (value: string) => value.replace(/\D/g, "");
const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);

// Why a bank link can't be requested (422), or null
export const relationshipRequestError = (request: { account_owner_name?: string; bank_account_type?: string; bank_account_number?: string; bank_routing_number?: string; processor_token?: string }): string | null => {
    // Plaid's processor tokens are for Alpaca; the simulator has no bank to look them up with
    if (request.processor_token) return "the simulator links banks by routing and account number, not Plaid processor tokens";
    if (!request.account_owner_name?.trim()) return "account_owner_name is required";
    if (request.bank_account_type !== "CHECKING" && request.bank_account_type !== "SAVINGS") return "bank_account_type must be CHECKING or SAVINGS";
    if (!routingValid(request.bank_routing_number ?? "")) return "bank_routing_number isn't a valid ABA routing number";
    if (!/^\d{4,17}$/.test(digits(request.bank_account_number ?? "")) || digits(request.bank_account_number ?? "") !== (request.bank_account_number ?? "").trim()) {
        return "bank_account_number must be 4 to 17 digits";
    }
    return null;
};

// Whether the bank verifies a link: the account's owner must be the account holder (their first and last name in the owner name,
// as Alpaca's name match requires), and an account number ending in 0000 fails verification, for testing
export const verifyRelationship = (ownerName: string, holder: { given_name: string; family_name: string }, accountNumber: string): string | null => {
    const owner = normalizeName(ownerName);
    const first = normalizeName(holder.given_name)[0];
    const last = normalizeName(holder.family_name).at(-1);
    if (!first || !last || !owner.includes(first) || !owner.includes(last)) return "The bank account's owner doesn't match the account holder";
    if (digits(accountNumber).endsWith("0000")) return "The bank couldn't verify the account";
    return null;
};

// Why a transfer can't be requested (422), or null. todayTotal is what the account has already moved that banking day in the same
// direction by ACH.
export const transferRequestError = (request: { transfer_type?: string; direction?: string; amount?: string }, { todayTotal }: { todayTotal: number }): string | null => {
    if (request.transfer_type !== "ach" && request.transfer_type !== "wire") return "transfer_type must be ach or wire";
    if (request.direction !== "INCOMING" && request.direction !== "OUTGOING") return "direction must be INCOMING or OUTGOING";
    if (request.transfer_type === "wire" && request.direction === "INCOMING") return "Incoming wires can't be requested through the API; send the wire to the account's instructions";
    if (!/^\d+(\.\d{1,2})?$/.test(request.amount ?? "")) return "amount must be a positive number with at most 2 decimals";
    const amount = Number(request.amount);
    if (amount < FUNDING_LIMITS.minimum) return `The minimum transfer is $${FUNDING_LIMITS.minimum}`;
    if (request.transfer_type === "ach" && todayTotal + amount > FUNDING_LIMITS.dailyAch) {
        return `ACH ${request.direction === "INCOMING" ? "deposits" : "withdrawals"} are limited to $${FUNDING_LIMITS.dailyAch.toLocaleString("en-US")} a day`;
    }
    return null;
};

// Why a wire recipient bank can't be added (422), or null
export const bankRequestError = (request: { name?: string; bank_code?: string; bank_code_type?: string; account_number?: string }): string | null => {
    if (!request.name?.trim()) return "name is required";
    if (request.bank_code_type !== "ABA") return "Only domestic (ABA) wires are offered";
    if (!routingValid(request.bank_code ?? "")) return "bank_code isn't a valid ABA routing number";
    if (!/^\d{4,17}$/.test(request.account_number ?? "")) return "account_number must be 4 to 17 digits";
    return null;
};

// How a stored bank account number is shown and returned: only its last 4 digits
export const maskAccountNumber = (accountNumber: string): string => `••••${digits(accountNumber).slice(-4)}`;
