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
}

// A cash_transfers row as the API returns it
export interface TransferRow {
    id: number;
    user_id: string;
    date: string;
    type: TransferType;
    method: string;
    amount: string;
}

// An open position: quantity is signed (negative for a short), avgCost is the average cost per share
export interface Position {
    ticker: string;
    quantity: number;
    avgCost: number;
}

// GET /api/portfolio: a position with its current price, or null and the reason it couldn't be fetched
export interface PortfolioPosition extends Position {
    price: number | null;
    error: string | null;
}

export type MarginStatus = "ok" | "margin_call" | "buy_in";

// The account's value at current prices (valueAccount in lib/server/account.ts)
export interface AccountValuation {
    totalCash: number;
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
    positions: { ticker: string; quantity: number }[];
    // The past week's automatic buy-in trades
    liquidations: TransactionRow[];
}

export type TickerVerdict = "BUY" | "HOLD" | "SELL";
export type PositionVerdict = "HOLD" | "SELL" | "COVER";

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

// POST /api/trading/[ticker]
export interface TradeRequest {
    transaction: {
        date: string;
        type: TradeType;
        ticker: string;
        price: number | string;
        quantity: number;
        total: number;
    };
    // From the Portfolio page: refuse (409) rather than flip a position that's smaller than the trade
    close?: boolean;
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
