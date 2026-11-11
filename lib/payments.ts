// Bank details checks shared by the bank link and wire forms and the simulator (lib/server/broker/sim/funding.ts)

export const digitsOnly = (text: string): string => text.replace(/\D/g, "");

// ABA routing number: 9 digits with a 3-7-1 weighted checksum (011000015 is a valid test number)
export const routingValid = (routing: string): boolean => {
    const digits = digitsOnly(routing);
    if (digits.length !== 9) return false;
    const d = [...digits].map(Number);
    const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    return sum % 10 === 0;
};

// A U.S. bank account number: 4 to 17 digits
export const accountNumberValid = (number: string): boolean => /^\d{4,17}$/.test(number);

// A positive dollar amount with at most 2 decimals (a number, or its text), in whole cents; null otherwise. Checked with a tolerance,
// since amount * 100 isn't exact in floating point (0.29 * 100 is 28.999999999999996)
export const parseDollarAmount = (value: unknown): number | null => {
    const amount = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
    if (!Number.isFinite(amount) || !(amount > 0)) return null;
    const cents = Math.round(amount * 100);
    if (cents < 1 || Math.abs(amount * 100 - cents) > 1e-6) return null;
    return cents / 100;
};
