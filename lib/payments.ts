// Format checks for the mock Deposit/Withdraw forms. Nothing here talks to a payment provider,
// and only describeMethod's label (e.g. "Visa •••• 4242") is sent to the server.

export const digitsOnly = (text: string): string => text.replace(/\D/g, "");

// Luhn checksum, which every real card number passes (e.g. the test number 4242 4242 4242 4242)
export const luhnValid = (number: string): boolean => {
    const digits = digitsOnly(number);
    if (digits.length < 12 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let digit = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
    }
    return sum % 10 === 0;
};

export const detectCardBrand = (number: string): string => {
    const digits = digitsOnly(number);
    if (/^4/.test(digits)) return "Visa";
    if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
    if (/^3[47]/.test(digits)) return "American Express";
    if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
    return "Card";
};

// Groups of 4 digits, or 4-6-5 for American Express
export const formatCardNumber = (number: string): string => {
    const digits = digitsOnly(number);
    const groups = detectCardBrand(digits) === "American Express" ? [4, 6, 5] : [4, 4, 4, 4, 3];
    const parts = [];
    let start = 0;
    for (const size of groups) {
        if (start >= digits.length) break;
        parts.push(digits.slice(start, start + size));
        start += size;
    }
    return parts.join(" ");
};

// MMYY digits that aren't in the past (a card is valid through the end of its expiry month)
export const expiryValid = (mmyy: string, now = new Date()): boolean => {
    const digits = digitsOnly(mmyy);
    if (digits.length !== 4) return false;
    const month = Number(digits.slice(0, 2));
    const year = 2000 + Number(digits.slice(2));
    if (month < 1 || month > 12) return false;
    return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
};

// ABA routing number: 9 digits with a 3-7-1 weighted checksum
export const routingValid = (routing: string): boolean => {
    const digits = digitsOnly(routing);
    if (digits.length !== 9) return false;
    const d = [...digits].map(Number);
    const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    return sum % 10 === 0;
};

export type PaymentMethod = "card" | "apple" | "google" | "paypal" | "bank";

export interface PaymentDetails {
    cardNumber: string;
    expiry: string;
    cvc: string;
    cardName: string;
    holderName: string;
    routingNumber: string;
    accountNumber: string;
    email: string;
}

// The label stored with a transfer and shown on the Transactions page
export const describeMethod = (method: PaymentMethod, details: PaymentDetails): string => {
    switch (method) {
        case "card":
            return `${detectCardBrand(details.cardNumber)} •••• ${digitsOnly(details.cardNumber).slice(-4)}`;
        case "bank":
            return `Bank account •••• ${digitsOnly(details.accountNumber).slice(-4)}`;
        case "paypal":
            return `PayPal (${details.email.trim()})`;
        case "apple":
            return "Apple Pay";
        case "google":
            return "Google Pay";
        default:
            return method;
    }
};
