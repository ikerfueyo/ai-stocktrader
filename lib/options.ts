// U.S. equity options as the app names them, shared by the server and the pages: OCC contract symbols (root, expiration YYMMDD, C or P,
// strike × 1000 in 8 digits, as Alpaca writes them: F261120C00012000), the contract multiplier (100 shares per standard contract), and
// Alpaca's options trading levels. Pure, so it can be unit tested.

export type OptionType = "call" | "put";

export interface OptionContractId {
    underlying: string;
    // "YYYY-MM-DD"
    expiration: string;
    type: OptionType;
    strike: number;
}

const OCC_SYMBOL = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export const isOptionSymbol = (symbol: string): boolean => OCC_SYMBOL.test(symbol.toUpperCase());

export const parseOptionSymbol = (symbol: string): OptionContractId | null => {
    const match = OCC_SYMBOL.exec(symbol.toUpperCase());
    if (!match) return null;
    const [, underlying, yy, mm, dd, kind, strike] = match;
    return { underlying, expiration: `20${yy}-${mm}-${dd}`, type: kind === "C" ? "call" : "put", strike: Number(strike) / 1000 };
};

export const optionSymbol = ({ underlying, expiration, type, strike }: OptionContractId): string =>
    `${underlying.toUpperCase()}${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

// Shares per unit of a position: 100 for an option contract (standard contracts only), 1 for a stock. Dollar figures are units × price ×
// this; prices stay per share, as quotes and Alpaca's fills give them.
export const contractMultiplier = (symbol: string): number => isOptionSymbol(symbol) ? 100 : 1;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Alpaca's contract name: "F Nov 20 2026 12 Call"
export const contractName = (symbol: string): string => {
    const contract = parseOptionSymbol(symbol);
    if (!contract) return symbol;
    const [year, month, day] = contract.expiration.split("-");
    return `${contract.underlying} ${MONTHS[Number(month) - 1]} ${Number(day)} ${year} ${contract.strike} ${contract.type === "call" ? "Call" : "Put"}`;
};

// What exercising is worth per share at an underlying price
export const intrinsicValue = (type: OptionType, strike: number, price: number): number => Math.max(0, type === "call" ? price - strike : strike - price);

// Calendar days from day to the expiration ("YYYY-MM-DD" both), 0 on expiration day
export const daysToExpiration = (expiration: string, day: string): number =>
    Math.round((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);

// Alpaca's options trading levels (options_approved_level, max_options_trading_level and the effective options_trading_level)
export const OPTIONS_LEVELS: Record<number, string> = {
    0: "Options trading off",
    1: "Level 1: covered calls and cash-secured puts",
    2: "Level 2: also buying calls and puts",
    3: "Level 3: also spreads"
};
