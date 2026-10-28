// Shapes shared by the API route handlers (app/api) and the pages that call them
import type { AccountApplication } from "./kyc";
import type { Order as BrokerOrder } from "./server/broker/types";

export type { AccountApplication };

export type TradeType = "BUY" | "SELL";
export type TransferType = "DEPOSIT" | "WITHDRAW";

// A transactions row as the API returns it. pg returns DECIMAL/NUMERIC columns as strings (parse quantity before doing math),
// and the date is a TIMESTAMPTZ serialized as an ISO string.
export interface TransactionRow {
    // The fill's activity ID in the broker's ledger
    id: number | string;
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
    // The order this trade filled (the broker's order ID), or NULL for a buy-in or a fill from before Phase 4 (legacy_order_id: the
    // app's mock order it filled)
    order_id: string | null;
    legacy_order_id?: number | null;
}

// Which price a trade filled at: the quoted ask (buys) or bid (sells), a simulated spread around the last price when there's no
// bid/ask data, the last price itself, or the opening or closing auction price (OPG and CLS orders)
export type FillPolicy = "ASK" | "BID" | "SIM_ASK" | "SIM_BID" | "LAST" | "OPEN" | "CLOSE";

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
    // The regular session so far (null when the quote came from the daily series fallback or an override)
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    // The latest pre-market or after-hours price, while there's one (Alpha Vantage's extended_hours_quote)
    extendedHoursPrice: number | null;
    // Alpaca's top of book with sizes (GET /api/quote/[ticker] only): the IEX exchange's on the free plan (ALPACA_DATA_FEED=iex),
    // the national best with sip. null without Alpaca keys or a current quote.
    book?: QuoteBook | null;
}

export interface QuoteBook {
    feed: "iex" | "sip";
    bid: number;
    bidSize: number;
    ask: number;
    askSize: number;
    // The latest trade on that feed
    lastPrice: number | null;
    lastSize: number | null;
    // ISO timestamp of the quote
    time: string;
}

export type CashActivityType = TransferType | "DIVIDEND_IN" | "DIVIDEND_OUT" | "FEE";

// An entry of the account's cash ledger as GET /api/transfers returns it: a deposit, withdrawal or fee from the broker's activities
// (method is its description; id is the activity's), or a dividend received on a long or paid on a short from the mock ledger
// (method describes it; ticker and reference, the ex-dividend date, identify it). amount is positive; the type gives the direction.
export interface CashActivityRow {
    id: number | string;
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
    // Withdrawals requested and not yet sent, already held from cash; and what can be withdrawn now: available cash less deposit
    // credit given before its ACH settled
    pendingTransferOut: number;
    withdrawableCash: number;
    // Sale proceeds that haven't settled (T+1), which can be traded with but not withdrawn yet, and regulatory fees accrued today,
    // deducted at the end of the day
    unsettledProceeds: number;
    accruedFees: number;
}

export type TickerVerdict = "BUY" | "HOLD" | "SELL";
export type PositionVerdict = "HOLD" | "SELL" | "COVER";

// GET /api/transactions: a trade with the P&L it realized (null if it only opened or added to a position)
export interface TradeHistoryRow extends TransactionRow {
    realized_pnl: number | null;
    // When the trade settles (T+1; its sale proceeds can be withdrawn from then)
    settle_date?: string | null;
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

// A reported quarter (Alpha Vantage EARNINGS), dates as "YYYY-MM-DD"
export interface QuarterResult {
    fiscalDateEnding: string;
    reportedDate: string;
    reportedEps: number;
    estimatedEps: number | null;
    // As a fraction of the estimate
    surprise: number | null;
}

// A consensus EPS estimate (Alpha Vantage EARNINGS_ESTIMATES) with the averages it's been revised from
export interface EpsEstimate {
    fiscalDateEnding: string;
    period: "quarter" | "year";
    average: number;
    analysts: number | null;
    average30DaysAgo: number | null;
    average90DaysAgo: number | null;
    revisionsUp30Days: number | null;
    revisionsDown30Days: number | null;
}

// The next scheduled report (Alpha Vantage EARNINGS_CALENDAR)
export interface NextReport {
    reportDate: string;
    fiscalDateEnding: string | null;
    // "pre-market" or "post-market"
    timeOfDay: string | null;
}

export interface EarningsSummary {
    // Newest first
    recent: QuarterResult[];
    // The quarter being reported next, then the fiscal years from the one it ends in
    estimates: (EpsEstimate & { change30Days: number | null; change90Days: number | null })[];
    next: (NextReport & { daysAway: number }) | null;
    // Days since the newest reported quarter's report
    daysSinceReport: number | null;
}

// GET /api/quote/[ticker]/earnings: the latest reported quarters against their estimates, the consensus estimates ahead and the
// next report date (the same summary the AI analysis gets)
export type EarningsResponse = EarningsSummary;

// GET /api/news/[ticker]: an article mainly about the ticker, newest first, with Alpha Vantage's sentiment for it (-1 bearish to 1
// bullish) and its relevance to the ticker (0 to 1)
export interface TickerNewsItem {
    title: string;
    url: string | null;
    summary: string;
    // ISO timestamp
    published: string;
    sentiment: number;
    relevance: number;
}

// GET /api/market/movers: today's biggest gainers and losers and the most traded stocks, tradable stocks only (Alpha Vantage
// TOP_GAINERS_LOSERS, which also lists warrants and ETFs)
export interface Mover {
    ticker: string;
    price: number;
    change: number;
    // As a fraction (0.05 = 5%)
    changePercent: number;
    volume: number;
}
export interface MarketMovers {
    gainers: Mover[];
    losers: Mover[];
    mostActive: Mover[];
    // ISO timestamp
    updatedAt: string | null;
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

// An order as the order routes return it: the broker's, with why it ended (the reason its trade event gave), when it did
export type AppOrder = BrokerOrder & { reason?: string | null };

// GET /api/orders/[id]: the order with its legs, and its fills (and those of the orders it replaced), newest first
export interface OrderDetails {
    order: AppOrder;
    fills: TradeHistoryRow[];
}

// GET /api/funding: transfer limits and fees, in dollars (minimum and dailyAch per transfer and banking day, instant the deposit
// credit given before settlement)
export interface FundingTerms {
    minimum: number;
    dailyAch: number;
    instant: number;
    wireFee: number;
    achReturnFee: number;
}

// POST /api/accounts/[id]/transfers: an ACH deposit from the bank link, or a withdrawal by ACH to it or by wire to a recipient bank
export interface TransferRequest {
    transfer: {
        type: "ach" | "wire";
        direction: "INCOMING" | "OUTGOING";
        amount: number;
        relationshipId?: string;
        bankId?: string;
    };
}

// Brokerage accounts. Account objects are Alpaca's (the broker's shape), re-exported for the pages.
export type {
    Account as BrokerAccount, AccountConfigurations, OptionsApprovalResponse, ACHRelationship as AchRelationship, Bank as RecipientBank,
    Transfer as BrokerTransfer, TradeAccount as BrokerTradeAccount, Activity as BrokerActivity, Position as BrokerPosition,
    Order as BrokerOrder, CreateOrderRequest as BrokerOrderRequest, UpdateOrderRequest as BrokerOrderUpdate
} from "./server/broker/types";

// GET /api/accounts/[id]/lots: an open tax lot (FIFO), with whether selling it now would be a long-term gain or loss
export interface TaxLot {
    id: string;
    symbol: string;
    side: "long" | "short";
    qty: number;
    // Split-adjusted shares when it was opened
    originalQty: number;
    price: number;
    costBasis: number;
    // ISO timestamp
    acquiredAt: string;
    longTerm: boolean;
}

export type BrokerAccountKind = "individual" | "traditional_ira" | "roth_ira";

// GET /api/accounts: one of the user's brokerage accounts with its status, and whether requests act on it (the header's switcher)
export interface BrokerAccountSummary {
    accountId: string;
    accountNumber: string;
    kind: BrokerAccountKind;
    status: string;
    createdAt: string;
    active: boolean;
}

// POST /api/accounts: an application for an individual account; options_level, with the options agreement, also asks for options
export interface OpenAccountRequest {
    application: AccountApplication;
}

// Every error response
export interface ApiError {
    error: string;
}
