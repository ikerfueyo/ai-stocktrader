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
    // The fill, for a FILLED order
    transaction_id?: number | null;
}

// Which price a trade filled at: the quoted ask (buys) or bid (sells), a simulated spread around the last price when there's no
// bid/ask data, or the last price itself
export type FillPolicy = "ASK" | "BID" | "SIM_ASK" | "SIM_BID" | "LAST";

// How current a quote is: realtime, 15-minute delayed, or the last session's close
export type QuoteDelay = "realtime" | "delayed" | "end-of-day";

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

// GET /api/analysis/[ticker]
export interface TickerAnalysis {
    verdict: TickerVerdict;
    analysis: string;
}

// GET /api/portfolio/[ticker]/analysis
export interface PositionAnalysis {
    verdict: PositionVerdict;
    analysis: string;
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
