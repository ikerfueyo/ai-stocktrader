// Shapes shared by the API route handlers (app/api) and the pages that call them

export type TradeType = "BUY" | "SELL";
export type TransferType = "DEPOSIT" | "WITHDRAW";

// A transactions row as the API returns it. pg returns DECIMAL/NUMERIC columns as strings (parse quantity before doing math),
// and the date is a TIMESTAMPTZ serialized as an ISO string.
export interface TransactionRow {
    id: number;
    user_id: string;
    date: string;
    type: TradeType;
    ticker: string;
    price: string;
    quantity: string;
    total: string;
    // NULL for the user's own trades, 'LIQUIDATION' for automatic collateral buy-ins
    reason: "LIQUIDATION" | null;
    // The time of the quote the trade filled against, and which side of it (NULL for trades from before fills were server-set)
    quote_time: string | null;
    fill_policy: FillPolicy | null;
    // The order this trade filled (limit, stop and queued orders), or NULL for an immediate market order or a buy-in
    order_id: number | null;
}

export type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type TimeInForce = "DAY" | "GTC";
export type OrderStatus = "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED" | "REJECTED";

// An orders row as the API returns it (NUMERIC columns as strings). quantity is null for a dollar-amount market order (amount).
export interface OrderRow {
    id: number;
    user_id: string;
    created_at: string;
    updated_at: string;
    ticker: string;
    side: TradeType;
    order_type: OrderType;
    quantity: string | null;
    amount: string | null;
    limit_price: string | null;
    stop_price: string | null;
    time_in_force: TimeInForce;
    expires_at: string | null;
    status: OrderStatus;
    triggered_at: string | null;
    status_reason: string | null;
    close_only: boolean;
    // The fill, for a FILLED order
    transaction_id?: number | null;
}

// Which price a trade filled at: the quoted ask (buys) or bid (sells), a simulated spread around the last price when there's no
// bid/ask data, or the last price itself
export type FillPolicy = "ASK" | "BID" | "SIM_ASK" | "SIM_BID" | "LAST";

// How current a quote is: realtime, or the last session's close
export type QuoteDelay = "realtime" | "end-of-day";

// A ticker's latest quote (GET /api/quote/[ticker]). bid and ask are quoted by Alpha Vantage, simulated around the last price
// (spread "simulated"), or null (spread "none").
export interface Quote {
    ticker: string;
    price: number;
    previousClose: number | null;
    bid: number | null;
    ask: number | null;
    spread: "quoted" | "simulated" | "none";
    // ISO timestamp of the price
    quoteTime: string;
    delay: QuoteDelay;
}

export type CashActivityType = TransferType | "DIVIDEND_IN" | "DIVIDEND_OUT";

// A cash_activity row as the API returns it: a deposit or withdrawal (method is the payment method's label), or a dividend received
// on a long or paid on a short (method describes it; ticker and reference, the ex-dividend date, identify it)
export interface CashActivityRow {
    id: number;
    user_id: string;
    date: string;
    type: CashActivityType;
    method: string;
    amount: string;
    ticker: string | null;
    reference: string | null;
}

// An open position: quantity is signed (negative for a short), avgCost is the average cost per share
export interface Position {
    ticker: string;
    quantity: number;
    avgCost: number;
}

// GET /api/portfolio: a position with its current price, the previous close and bid/ask, or null and the reason it couldn't be fetched
export interface PortfolioPosition extends Position {
    price: number | null;
    previousClose: number | null;
    bid: number | null;
    ask: number | null;
    error: string | null;
}

export type MarginStatus = "ok" | "margin_call" | "buy_in";

// The account's value at current prices (valueAccount in lib/server/account.ts)
export interface AccountValuation {
    totalCash: number;
    // Held back from available cash for open orders that would open or add to a position
    reservedCash: number;
    equity: number;
    unrealizedPnl: number;
    shortLiability: number;
    collateralRequirement: number;
    restrictedCash: number;
    availableCash: number;
    collateralShortfall: number;
    collateralRatio: number | null;
    marginStatus: MarginStatus;
    missingPrices: string[];
}

// GET /api/account
export interface Account extends AccountValuation {
    // Gains and losses booked on closed shares (average cost), and dividends received less dividends paid on shorts
    realizedPnl: number;
    netDividends: number;
    positions: { ticker: string; quantity: number }[];
    // The past week's automatic buy-in trades
    liquidations: TransactionRow[];
}

export type TickerVerdict = "BUY" | "HOLD" | "SELL";
export type PositionVerdict = "HOLD" | "SELL" | "COVER";

// GET /api/transactions: a trade with the P&L it realized (null if it only opened or added to a position)
export interface TradeHistoryRow extends TransactionRow {
    realized_pnl: number | null;
}

export type HistoryRange = "1W" | "1M" | "3M" | "YTD" | "1Y" | "ALL";

// GET /api/portfolio/history: daily equity, net deposits, the time-weighted return and SPY's price return over the range (both from
// its first day, as fractions), and the range's totals. missing lists tickers whose closes couldn't be fetched (valued at cost).
export interface PortfolioHistory {
    range: HistoryRange;
    // twr is null on days that started with zero or negative equity, when the day's return isn't defined
    points: { date: string; equity: number; netDeposits: number; twr: number | null; benchmark: number | null }[];
    twr: number | null;
    benchmarkReturn: number | null;
    benchmark: string;
    missing: string[];
}

// GET /api/quote/[ticker]/overview: a company's profile and key figures (null where Alpha Vantage has none)
export interface CompanyOverview {
    ticker: string;
    name: string;
    assetType: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    marketCap: number | null;
    peRatio: number | null;
    forwardPe: number | null;
    // As a fraction (0.0031 = 0.31%)
    dividendYield: number | null;
    beta: number | null;
    week52High: number | null;
    week52Low: number | null;
    exDividendDate: string | null;
    dividendDate: string | null;
    // Analysts' consensus target price and how many rate the stock each way (null when none are listed)
    analystTargetPrice: number | null;
    analystRatings: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
}

// GET /api/trading/[ticker]/intraday: a 5-minute bar; time is Eastern, "YYYY-MM-DD HH:MM:SS"
export interface IntradayBar {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// GET /api/search?q=
export interface SymbolMatch {
    symbol: string;
    name: string;
    type: string;
    region: string;
    currency: string;
}

// GET /api/watchlist: a watched ticker with its current price and change, and its AI verdict if one is cached
export interface WatchlistItem {
    ticker: string;
    addedAt: string;
    price: number | null;
    previousClose: number | null;
    verdict: TickerVerdict | null;
    error: string | null;
}

// An article an analysis cites
export interface AnalysisSource {
    title: string;
    url: string | null;
    // ISO timestamp
    published: string;
}

// The structured part of an AI analysis: the reasoning behind the verdict, over a fixed horizon, with the articles it cites and
// when and by which model it was made. No confidence percentages or price targets.
export interface AnalysisDetails {
    horizon: string;
    evidence: string[];
    counterarguments: string[];
    risks: string[];
    catalysts: string[];
    sources: AnalysisSource[];
    // ISO timestamps: when the analysis was made, and the newest data it used (the latest article or price)
    generatedAt: string;
    dataAsOf: string | null;
    model: string;
}

// GET /api/analysis/[ticker]: analysis is the thesis, one paragraph that agrees with the verdict
export interface TickerAnalysis extends AnalysisDetails {
    verdict: TickerVerdict;
    analysis: string;
}

// GET /api/portfolio/[ticker]/analysis: the same for an open position, with the verdict derived from the ticker's
export interface PositionAnalysis extends AnalysisDetails {
    verdict: PositionVerdict;
    analysis: string;
}

// How one verdict did over a number of sessions after the analysis: its count (analyses with that many sessions of closes since),
// average price return and average return less SPY's, as fractions, and for BUY and SELL the share that beat SPY in their direction
export interface VerdictOutcome {
    verdict: TickerVerdict;
    count: number;
    hitRate: number | null;
    averageReturn: number | null;
    averageExcessReturn: number | null;
}

// GET /api/analysis/track-record: how past ticker verdicts turned out, per prompt version (newest first), 5 and 20 sessions later
export interface TrackRecord {
    benchmark: string;
    versions: {
        promptVersion: number;
        // Analyses counted (one per ticker and session) and the first one's session
        analyses: number;
        since: string;
        horizons: { sessions: number; outcomes: VerdictOutcome[] }[];
    }[];
    // Tickers whose closes couldn't be fetched (left out)
    missing: string[];
}

// GET /api/rankings
export interface Rankings {
    buy: string[];
    sell: string[];
}

// One day of Alpha Vantage's TIME_SERIES_DAILY, with prices as strings
export interface DailyBar {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
}

// GET /api/trading/[ticker]: Alpha Vantage's TIME_SERIES_DAILY reply, passed through as is
export interface DailySeries {
    "Meta Data": Record<string, string>;
    "Time Series (Daily)": Record<string, DailyBar>;
}

// POST /api/trading/[ticker]: a market order for a number of shares or a dollar amount (one of the two). The server sets the
// fill price (the ask for buys, the bid for sells), the total and the time. While the market is closed it's queued as an order
// for the open instead (TradeResponse).
export interface TradeRequest {
    order: {
        type: TradeType;
        quantity?: number;
        amount?: number;
    };
    // From the Portfolio page: refuse (409) rather than flip a position that's smaller than the trade
    close?: boolean;
}

// POST /api/trading/[ticker]: the fill, or the queued order while the market is closed
export type TradeResponse = { fill: TransactionRow; order?: undefined } | { order: OrderRow; fill?: undefined };

// POST /api/orders: a limit, stop or stop-limit order for a number of shares
export interface OrderRequest {
    order: {
        ticker: string;
        side: TradeType;
        orderType: Exclude<OrderType, "MARKET">;
        quantity: number;
        limitPrice?: number;
        stopPrice?: number;
        timeInForce: TimeInForce;
    };
}

// POST /api/transfers
export interface TransferRequest {
    transfer: {
        type: TransferType;
        method: string;
        amount: number;
    };
}

// Every error response
export interface ApiError {
    error: string;
}
