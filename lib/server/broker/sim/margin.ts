// Margin as Alpaca applies it to U.S. equities (docs.alpaca.markets/docs/margin-and-short-selling): buying power, Reg T initial
// margin, the house maintenance requirements, margin calls and the liquidation that meets them, margin interest and hard-to-borrow
// fees. Pure, so it can be unit tested; ./marginAccount.ts runs it on the account's ledger, assets and quotes.
//   Multiplier: 1x below $2,000 of equity or without the margin agreement; otherwise the account's max_margin_multiplier, 2x
//   overnight (Reg T) and, for 4x accounts, 4x intraday during the regular session (positions back within 2x by the close, or a
//   Reg T call follows).
//   buying_power: cash at 1x (less what the shorts need under Reg T); max(equity - initial margin, 0) × the multiplier above it, with
//   initial margin at 1 / multiplier of marginable positions and 100% of non-marginable ones. Open orders that would open or add to a
//   position hold some of it back.
//   Maintenance: longs 100% below $2.50, 50% to $6.00, 30% above; shorts the greater of $2.50 a share or 100% below $5.00, the greater
//   of $5.00 a share or 30% from $5.00; non-marginable longs 100%; an asset's own requirement when higher; 50% for a concentrated
//   position (70% or more of the account's market value, with a margin balance of $100,000 or more).
import { roundCents } from "../../account";

export const MIN_MARGIN_EQUITY = 2000;
export const REG_T_INITIAL = 0.5;
const CONCENTRATION_SHARE = 0.7;
const CONCENTRATION_DEBIT = 100000;
const CONCENTRATED_RATE = 0.5;
const ROUND_LOT = 100;

export interface MarginAsset {
    marginable: boolean | null;
    // The asset's own maintenance requirements, in percent (Alpaca's margin_requirement_long/_short), when it has them
    marginRequirementLong: number | null;
    marginRequirementShort: number | null;
}

export interface MarginPosition {
    symbol: string;
    // Signed: negative for a short
    qty: number;
    price: number;
    asset: MarginAsset | null;
}

export type Session = "pre-market" | "regular" | "after-hours" | "closed";

export interface MarginInput {
    cash: number;
    positions: MarginPosition[];
    // What the account may use: 1 without the margin agreement, else its max_margin_multiplier (2 or 4)
    maxMultiplier: number;
    session: Session;
    // Buying power held back for open orders (reservedForOrders)
    reserved?: number;
}

export interface MarginState {
    cash: number;
    longMarketValue: number;
    // Positive: what it would cost to buy back the shorts
    shortMarketValue: number;
    equity: number;
    // The multiplier in effect now (1 below $2,000 of equity, 4 only intraday) and the one the account allows
    multiplier: number;
    maxMultiplier: number;
    // Reg T initial margin (50%, 100% for non-marginable), and the intraday initial margin at the multiplier in effect
    initialMargin: number;
    maintenanceMargin: number;
    buyingPower: number;
    regtBuyingPower: number;
    nonMarginableBuyingPower: number;
    // Borrowed cash (a negative cash balance), and equity above the maintenance requirement
    debit: number;
    excessLiquidity: number;
    // Approximated as the excess over Reg T initial margin (the simulator doesn't keep a running SMA)
    sma: number;
    // The symbol whose concentration raised its requirement, if any
    concentrated: string | null;
}

const marginable = (position: MarginPosition) => position.asset?.marginable !== false;
const value = (position: MarginPosition) => Math.abs(position.qty) * position.price;

// The multiplier in effect: 1x below $2,000 of equity, else the account's own, 4x only during the regular session
export const effectiveMultiplier = (equity: number, maxMultiplier: number, session: Session): number => {
    if (maxMultiplier <= 1 || equity < MIN_MARGIN_EQUITY) return 1;
    if (maxMultiplier >= 4) return session === "regular" ? 4 : 2;
    return 2;
};

// A position's initial requirement at a multiplier: 1 / multiplier of its value when marginable (Reg T's 50% at 2x), else all of it
export const initialFor = (position: MarginPosition, multiplier: number): number =>
    value(position) * (marginable(position) && multiplier > 1 ? 1 / multiplier : 1);

// A position's house maintenance requirement in dollars
export const maintenanceFor = (position: MarginPosition, { concentrated = false }: { concentrated?: boolean } = {}): number => {
    const shares = Math.abs(position.qty);
    const marketValue = shares * position.price;
    if (position.qty > 0) {
        let rate = !marginable(position) || position.price < 2.5 ? 1 : position.price <= 6 ? 0.5 : 0.3;
        if (position.asset?.marginRequirementLong) rate = Math.max(rate, position.asset.marginRequirementLong / 100);
        if (concentrated) rate = Math.max(rate, CONCENTRATED_RATE);
        return marketValue * rate;
    }
    let requirement = position.price < 5 ? Math.max(2.5 * shares, marketValue) : Math.max(5 * shares, 0.3 * marketValue);
    if (position.asset?.marginRequirementShort) requirement = Math.max(requirement, marketValue * position.asset.marginRequirementShort / 100);
    if (concentrated) requirement = Math.max(requirement, marketValue * CONCENTRATED_RATE);
    return requirement;
};

// The account's margin figures now
export const computeMargin = ({ cash, positions, maxMultiplier, session, reserved = 0 }: MarginInput): MarginState => {
    let longMarketValue = 0;
    let shortMarketValue = 0;
    for (const position of positions) {
        if (position.qty > 0) longMarketValue += value(position);
        else if (position.qty < 0) shortMarketValue += value(position);
    }
    const equity = cash + longMarketValue - shortMarketValue;
    const debit = Math.max(0, -cash);
    const totalValue = longMarketValue + shortMarketValue;
    const concentrated = debit >= CONCENTRATION_DEBIT && totalValue > 0
        ? positions.find(position => value(position) >= CONCENTRATION_SHARE * totalValue)?.symbol ?? null
        : null;
    const initialMargin = positions.reduce((sum, position) => sum + initialFor(position, 2), 0);
    const maintenanceMargin = positions.reduce((sum, position) => sum + maintenanceFor(position, { concentrated: position.symbol === concentrated }), 0);
    const multiplier = effectiveMultiplier(equity, maxMultiplier, session);
    const regtExcess = Math.max(0, equity - initialMargin);
    let buyingPower: number;
    if (multiplier === 1) {
        // Cash, less what the shorts' Reg T requirement holds back (equity - initial margin never exceeds cash for a long-only account)
        buyingPower = Math.max(0, Math.min(cash, regtExcess));
    } else {
        const intradayInitial = positions.reduce((sum, position) => sum + initialFor(position, multiplier), 0);
        buyingPower = Math.max(0, equity - intradayInitial) * multiplier;
    }
    const regtBuyingPower = multiplier === 1 ? buyingPower : regtExcess * 2;
    const nonMarginableBuyingPower = multiplier === 1 ? buyingPower : regtExcess;
    return {
        cash: roundCents(cash), longMarketValue: roundCents(longMarketValue), shortMarketValue: roundCents(shortMarketValue), equity: roundCents(equity),
        multiplier, maxMultiplier, initialMargin: roundCents(initialMargin), maintenanceMargin: roundCents(maintenanceMargin),
        buyingPower: roundCents(Math.max(0, buyingPower - reserved)),
        regtBuyingPower: roundCents(Math.max(0, regtBuyingPower - reserved)),
        nonMarginableBuyingPower: roundCents(Math.max(0, nonMarginableBuyingPower - reserved / Math.max(1, multiplier))),
        debit: roundCents(debit), excessLiquidity: roundCents(equity - maintenanceMargin), sma: roundCents(regtExcess), concentrated
    };
};

// How much buying power an order worth value uses: its value, or for a non-marginable stock on margin, value × the multiplier (it
// needs 100% initial margin)
export const buyingPowerCost = (orderValue: number, { marginable: isMarginable, multiplier }: { marginable: boolean | null; multiplier: number }): number =>
    isMarginable === false && multiplier > 1 ? orderValue * multiplier : orderValue;

// Why the account can't open a short now, or null: shorting needs the margin agreement, shorting enabled and $2,000 of equity
export const shortingBlocked = ({ hasMarginAgreement, noShorting, equity }: { hasMarginAgreement: boolean; noShorting: boolean; equity: number }): string | null => {
    if (!hasMarginAgreement) return "shorting needs a margin account (the margin agreement)";
    if (noShorting) return "shorting is turned off for this account (no_shorting)";
    if (equity < MIN_MARGIN_EQUITY) return `shorting needs at least $${MIN_MARGIN_EQUITY.toLocaleString("en-US")} of equity`;
    return null;
};

export type CallType = "maintenance" | "regt";

// What the account is short of: maintenance (equity below the maintenance requirement, from any cause) and Reg T (equity below
// initial margin, which only calls for payment after a day that opened or added to positions, not after a fall in prices)
export const deficiencies = (state: Pick<MarginState, "equity" | "initialMargin" | "maintenanceMargin">, { openedToday }: { openedToday: boolean }): Record<CallType, number> => ({
    maintenance: roundCents(Math.max(0, state.maintenanceMargin - state.equity)),
    regt: openedToday ? roundCents(Math.max(0, state.initialMargin - state.equity)) : 0
});

// Whether equity is so far below the maintenance requirement that Alpaca liquidates at once rather than waiting for the call (equity
// below ratio × the requirement, SIM_LIQUIDATION_RATIO), or gone altogether
export const needsImmediateLiquidation = (state: Pick<MarginState, "equity" | "maintenanceMargin" | "longMarketValue" | "shortMarketValue">, ratio: number): boolean =>
    (state.longMarketValue > 0 || state.shortMarketValue > 0) && (state.equity <= 0 || state.equity < ratio * state.maintenanceMargin);

export interface LiquidationTrade {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
}

// The closing trades that cover a deficiency of a type, riskiest positions first (the highest requirement per dollar), each just
// enough with a margin of buffer: closing $V of a position at requirement rate r releases r × V of the requirement (and costs only the
// spread in equity). Whole shares for whole-share positions, rounded up. When equity is gone, every position is closed.
export const planLiquidation = (positions: MarginPosition[], deficiency: number, { type, equity, buffer = 0.05 }: { type: CallType; equity: number; buffer?: number }): LiquidationTrade[] => {
    const closeAll = equity <= 0;
    const rated = positions
        .filter(position => position.qty !== 0 && position.price > 0)
        .map(position => ({ position, rate: (type === "regt" ? initialFor(position, 2) : maintenanceFor(position)) / value(position) }))
        .sort((a, b) => b.rate - a.rate || value(b.position) - value(a.position));
    let left = deficiency * (1 + buffer);
    const trades: LiquidationTrade[] = [];
    for (const { position, rate } of rated) {
        if (!closeAll && left <= 0) break;
        const held = Math.abs(position.qty);
        const wanted = closeAll ? held : Math.min(held, left / rate / position.price);
        const whole = Number.isInteger(held);
        const qty = Math.min(held, whole ? Math.ceil(wanted - 1e-9) : Math.ceil(wanted * 1e6 - 1e-6) / 1e6);
        if (!(qty > 0)) continue;
        trades.push({ symbol: position.symbol, side: position.qty > 0 ? "sell" : "buy", qty });
        left -= qty * position.price * rate;
    }
    return trades;
};

// Margin interest for one end of day: the settlement-date debit balance × the annual rate / 360, for each calendar day until the
// next trading day (a Friday's balance accrues three days)
export const marginInterest = (debit: number, rate: number, days: number): number => debit > 0 ? debit * rate / 360 * days : 0;

// The daily borrow fee on a hard-to-borrow short: its market value, on the nearest round lot above its shares, × the borrow rate / 360,
// for each calendar day until the next trading day
export const borrowFee = ({ qty, price, rate, days }: { qty: number; price: number; rate: number; days: number }): number =>
    Math.ceil(Math.abs(qty) / ROUND_LOT) * ROUND_LOT * price * rate / 360 * days;

// Locates come in round lots
export const isRoundLot = (qty: number) => Number.isInteger(qty) && qty > 0 && qty % ROUND_LOT === 0;
