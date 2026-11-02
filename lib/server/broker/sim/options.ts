// Options in the simulator, following Alpaca's rules (docs.alpaca.markets/docs/options-trading and options-level-3-trading). Pure, so it
// can be unit tested; ./orders.ts, ./marginAccount.ts and ./optionEvents.ts run it on the ledger.
//   Orders: market, limit, stop or stop limit (stops single-leg only), day or GTC, whole contracts, never notional or extended hours; on
//   an expiring contract only before 3:15 p.m. ET on its expiration day. Prices tick by $0.01 below $3.00 and $0.05 from $3.00 (the
//   penny program's increments; mleg net prices by $0.01).
//   Levels: 1 sells covered calls and cash-secured puts, 2 also buys calls and puts, 3 also trades spreads (mleg orders, and short calls
//   covered by long calls). Closing a position needs no level. Uncovered short calls aren't allowed at any level.
//   Requirement (the universal spread rule): the worst loss at expiration of the account's option positions in one underlying, with its
//   long shares, valued at intrinsic value, for each expiration of a short option (with the longs that expire with it or later), the
//   largest of them. A covered call needs nothing; a cash-secured put its strike; a spread its width. Long options are paid in full.
//   Expiration: in the money by $0.01 or more, longs are exercised and shorts assigned; the rest expire worthless.
import { BrokerError } from "../errors";
import { intrinsicValue, parseOptionSymbol, type OptionContractId, type OptionType } from "../../../options";
import { easternParts, easternTime } from "../../../marketHours";
import type { OrderSide, OrderType, PositionIntent, TimeInForce } from "../types";

const invalid = (message: string) => new BrokerError(422, 40010001, message);
const forbidden = (message: string) => new BrokerError(403, 40310000, message);

export const OPTION_MULTIPLIER = 100;
// Alpaca's cutoff for orders on contracts expiring today (3:30 p.m. for broad-based ETFs, which the app doesn't offer)
export const EXPIRATION_DAY_CUTOFF = "15:15";
// The yearly risk-free rate the model prices with
const RISK_FREE_RATE = 0.04;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Pricing

// The standard normal distribution's CDF (Abramowitz and Stegun 26.2.17, accurate to 7.5e-8) and density
const normalCdf = (x: number): number => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
};
const normalPdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

export interface Greeks {
    price: number;
    delta: number;
    gamma: number;
    // Per calendar day
    theta: number;
    // Per point of volatility (0.01)
    vega: number;
}

// Black-Scholes for a European option on a stock without dividends (an approximation for American equity options): years to expiration,
// yearly volatility. At or past expiration, its intrinsic value.
export const blackScholes = ({ type, price, strike, years, volatility, rate = RISK_FREE_RATE }: { type: OptionType; price: number; strike: number; years: number; volatility: number; rate?: number }): Greeks => {
    if (years <= 0 || volatility <= 0 || price <= 0) {
        const itm = intrinsicValue(type, strike, price) > 0;
        return { price: intrinsicValue(type, strike, price), delta: itm ? (type === "call" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
    }
    const root = Math.sqrt(years);
    const d1 = (Math.log(price / strike) + (rate + volatility * volatility / 2) * years) / (volatility * root);
    const d2 = d1 - volatility * root;
    const discount = Math.exp(-rate * years);
    const call = type === "call";
    const value = call ? price * normalCdf(d1) - strike * discount * normalCdf(d2) : strike * discount * normalCdf(-d2) - price * normalCdf(-d1);
    const decay = -price * normalPdf(d1) * volatility / (2 * root) + (call ? -rate * strike * discount * normalCdf(d2) : rate * strike * discount * normalCdf(-d2));
    return {
        price: Math.max(value, 0),
        delta: call ? normalCdf(d1) : normalCdf(d1) - 1,
        gamma: normalPdf(d1) / (price * volatility * root),
        theta: decay / 365,
        vega: price * normalPdf(d1) * root / 100
    };
};

// Years from an instant to the contract's expiration (its close, 4:00 p.m. ET)
export const yearsToExpiration = (expiration: string, at: Date): number => Math.max(0, (easternTime(expiration, "16:00").getTime() - at.getTime()) / YEAR_MS);

// The price increment of an option at a price: $0.01 below $3.00, $0.05 from $3.00
export const optionTick = (price: number) => price < 3 ? 0.01 : 0.05;

const roundTo = (value: number, tick: number, mode: "down" | "up" | "nearest") => {
    const units = value / tick;
    const rounded = mode === "down" ? Math.floor(units + 1e-9) : mode === "up" ? Math.ceil(units - 1e-9) : Math.round(units);
    return Math.round(rounded * tick * 100) / 100;
};

// One contract of the last session's chain (Alpha Vantage's HISTORICAL_OPTIONS)
export interface ChainContract extends OptionContractId {
    symbol: string;
    // The chain's session ("YYYY-MM-DD"), whose close the prices are from
    date: string;
    last: number | null;
    mark: number | null;
    bid: number | null;
    ask: number | null;
    bidSize: number | null;
    askSize: number | null;
    volume: number | null;
    openInterest: number | null;
    impliedVolatility: number | null;
}

export interface OptionQuoteModel extends Greeks {
    bid: number;
    ask: number;
    impliedVolatility: number;
}

// A sane implied volatility (the chain has some placeholders, such as 0.01 on deep in-the-money contracts)
export const usableVolatility = (iv: number | null): number | null => iv !== null && iv >= 0.05 && iv <= 5 ? iv : null;

// The contract's quote now, modeled from the last close: its closing mark moved by what Black-Scholes at its implied volatility says the
// underlying's move and the time since are worth, never below intrinsic value, with the closing bid/ask spread around it (at least a
// tick each way) on the contract's price increments. fallbackVolatility is for contracts without a usable one (the median of their
// expiration's). Without a closing mark the model price is used as is.
export const modelOptionQuote = (contract: ChainContract, { underlying, underlyingAtClose, now, fallbackVolatility }: { underlying: number; underlyingAtClose: number; now: Date; fallbackVolatility: number }): OptionQuoteModel => {
    const volatility = usableVolatility(contract.impliedVolatility) ?? fallbackVolatility;
    const at = (price: number, instant: Date) => blackScholes({ type: contract.type, price, strike: contract.strike, years: yearsToExpiration(contract.expiration, instant), volatility });
    const nowModel = at(underlying, now);
    const closeMark = contract.mark ?? (contract.bid !== null && contract.ask !== null && contract.ask > 0 ? (contract.bid + contract.ask) / 2 : null);
    const intrinsic = intrinsicValue(contract.type, contract.strike, underlying);
    const moved = closeMark === null ? nowModel.price : closeMark + nowModel.price - at(underlyingAtClose, easternTime(contract.date, "16:00")).price;
    const mark = Math.max(intrinsic, moved, 0);
    const closingSpread = contract.bid !== null && contract.ask !== null && contract.ask > contract.bid ? contract.ask - contract.bid : Math.max(0.02, mark * 0.1);
    const half = Math.max(closingSpread / 2, 0.01);
    // Each side on the increment of its own price
    const bid = Math.max(0, roundTo(mark - half, optionTick(mark - half), "down"));
    const ask = Math.max(roundTo(mark + half, optionTick(mark + half), "up"), bid + optionTick(bid));
    return { ...nowModel, price: Math.round(mark * 100) / 100, bid, ask: Math.round(ask * 100) / 100, impliedVolatility: volatility };
};

// The median of the usable implied volatilities, for contracts without one (0.3 when none has one)
export const medianVolatility = (contracts: Pick<ChainContract, "impliedVolatility">[]): number => {
    const values = contracts.map(({ impliedVolatility }) => usableVolatility(impliedVolatility)).filter((iv): iv is number => iv !== null).sort((a, b) => a - b);
    if (values.length === 0) return 0.3;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

// Requirement (the universal spread rule)

export interface OptionHolding extends OptionContractId {
    // Signed contracts: negative for a short
    qty: number;
}

// The worst loss at expiration of options in one underlying, with long shares, for one expiration's shorts: the payoff at intrinsic value
// (premiums left out) at no price, each strike and beyond the highest, Infinity when calls are short beyond what longs and shares cover
const worstLoss = (options: OptionHolding[], shares: number): number => {
    const payoff = (price: number) => options.reduce((sum, option) => sum + option.qty * OPTION_MULTIPLIER * intrinsicValue(option.type, option.strike, price), 0) + shares * price;
    const slope = options.filter(({ type }) => type === "call").reduce((sum, { qty }) => sum + qty * OPTION_MULTIPLIER, 0) + shares;
    if (slope < -1e-9) return Infinity;
    const prices = [0, ...options.map(({ strike }) => strike)];
    return Math.max(0, -Math.min(...prices.map(payoff)));
};

// The requirement of an underlying's options: for each expiration of a short option, the worst loss of the shorts expiring then and the
// options (and shares) that last at least as long; the largest. Long-only holdings need nothing here (they're paid in full).
export const optionRequirement = (options: OptionHolding[], longShares = 0): number => {
    const shortExpirations = [...new Set(options.filter(({ qty }) => qty < 0).map(({ expiration }) => expiration))];
    let requirement = 0;
    for (const expiration of shortExpirations) {
        const considered = options.filter(option => option.expiration >= expiration && (option.qty > 0 || option.expiration === expiration));
        requirement = Math.max(requirement, worstLoss(considered, Math.max(0, longShares)));
    }
    return requirement;
};

// The shares that cover short calls (which can't be sold while they do): the calls short beyond what longs cover, at each expiration
export const sharesCoveringCalls = (options: OptionHolding[]): number => {
    let needed = 0;
    for (const expiration of new Set(options.filter(({ qty, type }) => qty < 0 && type === "call").map(({ expiration }) => expiration))) {
        const net = options.filter(option => option.type === "call" && option.expiration >= expiration && (option.qty > 0 || option.expiration === expiration))
            .reduce((sum, { qty }) => sum + qty * OPTION_MULTIPLIER, 0);
        needed = Math.max(needed, -net);
    }
    return needed;
};

// Every holding of the account grouped by underlying, with its long shares
export const requirementByUnderlying = (positions: { symbol: string; qty: number }[]): Map<string, number> => {
    const options = new Map<string, OptionHolding[]>();
    const shares = new Map<string, number>();
    for (const { symbol, qty } of positions) {
        const contract = parseOptionSymbol(symbol);
        if (contract) options.set(contract.underlying, [...(options.get(contract.underlying) ?? []), { ...contract, qty }]);
        else if (qty > 0) shares.set(symbol, qty);
    }
    return new Map([...options].map(([underlying, held]) => [underlying, optionRequirement(held, shares.get(underlying) ?? 0)]));
};

export const totalOptionRequirement = (positions: { symbol: string; qty: number }[]): number =>
    [...requirementByUnderlying(positions).values()].reduce((sum, value) => sum + value, 0);

// Orders

export interface OptionLeg {
    symbol: string;
    side: OrderSide;
    // Contracts per unit of the order (1 for a single-leg order)
    ratio: number;
    positionIntent: PositionIntent | null;
}

// Whether a leg opens a position: its intent, else trading against no position (or one on the same side)
export const legOpens = (leg: Pick<OptionLeg, "side" | "positionIntent">, position: number): boolean =>
    leg.positionIntent ? leg.positionIntent.endsWith("_to_open") : leg.side === "buy" ? position >= 0 : position <= 0;

// The level an order needs: closing legs none, a covered call or cash-secured put 1, a long option 2, a spread (an mleg order, or a short
// call covered by long calls) 3. A short call covered by neither shares nor long calls is refused.
export const requiredLevel = (legs: (OptionLeg & { opens: boolean })[], { holdings, longShares, mleg }: { holdings: OptionHolding[]; longShares: number; mleg: boolean }): number => {
    const opening = legs.filter(({ opens }) => opens);
    if (opening.length === 0) return 0;
    if (mleg) return 3;
    const [leg] = opening;
    if (leg.side === "buy") return 2;
    const contract = parseOptionSymbol(leg.symbol)!;
    if (contract.type === "put") return 1;
    const after = [...holdings, { ...contract, qty: -leg.ratio }];
    const coveredByShares = sharesCoveringCalls(after) <= longShares + 1e-9;
    if (coveredByShares && sharesCoveringCalls(after.filter(({ qty }) => qty < 0)) <= longShares + 1e-9) return 1;
    if (coveredByShares) return 3;
    throw forbidden(`uncovered short calls aren't allowed: selling ${leg.symbol} needs ${OPTION_MULTIPLIER * leg.ratio} shares of ${contract.underlying} or a long call that covers it`);
};

// Alpaca accepts an mleg order only when every short leg it opens is covered within the order: by a long leg of the same type it opens,
// expiring no sooner (any strike), contract for contract
export const mlegCoverageError = (legs: (OptionLeg & { opens: boolean })[]): string | null => {
    for (const type of ["call", "put"] as const) {
        const parsed = legs.filter(({ opens }) => opens).map(leg => ({ leg, contract: parseOptionSymbol(leg.symbol)! })).filter(({ contract }) => contract.type === type);
        const longs = parsed.filter(({ leg }) => leg.side === "buy").map(({ contract, leg }) => ({ expiration: contract.expiration, left: leg.ratio }));
        for (const { leg, contract } of parsed.filter(({ leg }) => leg.side === "sell").sort((a, b) => b.contract.expiration.localeCompare(a.contract.expiration))) {
            let short = leg.ratio;
            for (const long of longs.filter(({ expiration }) => expiration >= contract.expiration)) {
                const used = Math.min(long.left, short);
                long.left -= used;
                short -= used;
            }
            if (short > 0) return `uncovered option legs aren't allowed in an mleg order: ${leg.symbol} isn't covered by a long ${type} in the order`;
        }
    }
    return null;
};

const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);

// Checks an option order's terms (single-leg, or an mleg order's legs and its net limit price) against Alpaca's rules
export const validateOptionOrder = (order: { type: OrderType; timeInForce: TimeInForce; qty: number | null; notional: number | null; extendedHours: boolean; limitPrice: number | null; stopPrice: number | null; legs: OptionLeg[]; mleg: boolean }, now: Date) => {
    if (order.notional !== null) throw invalid("notional orders aren't allowed for options");
    if (order.qty === null || !Number.isInteger(order.qty) || order.qty < 1) throw invalid("qty must be a whole number of contracts");
    if (!["market", "limit", "stop", "stop_limit"].includes(order.type)) throw invalid("option orders must be market, limit, stop or stop_limit orders");
    if (order.mleg && order.type !== "market" && order.type !== "limit") throw invalid("mleg orders must be market or limit orders");
    if (order.timeInForce !== "day" && order.timeInForce !== "gtc") throw invalid("option orders must be day or gtc");
    if (order.extendedHours) throw invalid("option orders can't trade in extended hours");
    if ((order.type === "limit" || order.type === "stop_limit") && order.limitPrice === null) throw invalid("limit_price is required for limit orders");
    if ((order.type === "stop" || order.type === "stop_limit") && order.stopPrice === null) throw invalid("stop_price is required for stop orders");
    for (const [field, price] of [["limit_price", order.limitPrice], ["stop_price", order.stopPrice]] as const) {
        if (price === null) continue;
        const tick = order.mleg ? 0.01 : optionTick(Math.abs(price));
        if (Math.abs(Math.round(Math.abs(price) / tick) * tick - Math.abs(price)) > 1e-9) {
            throw new BrokerError(422, 42210000, `invalid ${field} ${price}: option prices tick by $${tick.toFixed(2)}${order.mleg ? "" : " at that price"}`);
        }
    }
    if (order.mleg) {
        if (order.legs.length < 2 || order.legs.length > 4) throw invalid("mleg orders need 2 to 4 legs");
        if (new Set(order.legs.map(({ symbol }) => symbol)).size !== order.legs.length) throw invalid("each leg of an mleg order must be a different contract");
        if (order.legs.some(({ ratio }) => !Number.isInteger(ratio) || ratio < 1)) throw invalid("ratio_qty must be a whole number");
        if (order.legs.map(({ ratio }) => ratio).reduce(gcd) !== 1) throw invalid("the greatest common divisor of the legs' ratio_qty must be 1");
        if (new Set(order.legs.map(({ symbol }) => parseOptionSymbol(symbol)?.underlying)).size !== 1) throw invalid("an mleg order's legs must share one underlying");
    }
    const today = easternParts(now).dateKey;
    for (const { symbol, positionIntent, side } of order.legs) {
        const contract = parseOptionSymbol(symbol);
        if (!contract) throw invalid(`${symbol} isn't an option contract symbol`);
        if (positionIntent && !positionIntent.startsWith(side)) throw invalid(`position_intent ${positionIntent} doesn't match side ${side}`);
        if (contract.expiration < today) throw invalid(`${symbol} has expired`);
        if (contract.expiration === today && easternParts(now).time >= EXPIRATION_DAY_CUTOFF) {
            throw forbidden(`orders on contracts expiring today aren't accepted after 3:15 p.m. ET`);
        }
    }
};

// An mleg order's net price per unit at the quotes: what the buys cost at the ask less what the sells bring at the bid (positive a debit,
// negative a credit), as its limit price is written
export const mlegNetPrice = (legs: Pick<OptionLeg, "side" | "ratio">[], quotes: { bid: number; ask: number }[]): number =>
    Math.round(legs.reduce((sum, leg, index) => sum + leg.ratio * (leg.side === "buy" ? quotes[index].ask : -quotes[index].bid), 0) * 100) / 100;

// Expiration

export type ExpirationOutcome = "exercise" | "assign" | "expire";

// What happens to a position at expiration at the underlying's closing price: in the money by $0.01 or more, a long is exercised (unless
// told not to) and a short assigned; otherwise it expires worthless
export const expirationOutcome = (holding: Pick<OptionHolding, "type" | "strike" | "qty">, closingPrice: number, { doNotExercise = false }: { doNotExercise?: boolean } = {}): ExpirationOutcome => {
    const itm = intrinsicValue(holding.type, holding.strike, closingPrice) >= 0.01 - 1e-9;
    if (!itm) return "expire";
    if (holding.qty < 0) return "assign";
    return doNotExercise ? "expire" : "exercise";
};

// Whether a short call is likely assigned early, the day before an ex-dividend date: in the money with less time value left than the
// dividend (a holder exercising captures the dividend for less than the time value given up)
export const earlyAssignmentLikely = ({ type, strike, underlying, optionPrice, dividend }: { type: OptionType; strike: number; underlying: number; optionPrice: number; dividend: number }): boolean => {
    if (type !== "call") return false;
    const intrinsic = intrinsicValue(type, strike, underlying);
    return intrinsic >= 0.01 && optionPrice - intrinsic < dividend;
};

// The stock trade an exercise or assignment makes, per contract held: shares at the strike, the premium rolled into the price the lots
// use (a long call's cost and a short put's are the strike ± the premium; a long put's and short call's proceeds likewise)
export const deliveryFor = ({ type, strike, qty, premium }: { type: OptionType; strike: number; qty: number; premium: number }) => {
    const long = qty > 0;
    const buysShares = (type === "call") === long;
    return {
        side: buysShares ? "buy" as const : "sell" as const,
        shares: Math.abs(qty) * OPTION_MULTIPLIER,
        cashPrice: strike,
        // A long paid the premium (more cost, less proceeds); a short received it (less cost, more proceeds)
        lotPrice: Math.round((buysShares === long ? strike + premium : strike - premium) * 1e6) / 1e6
    };
};
