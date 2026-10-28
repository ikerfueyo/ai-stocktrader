// The brokerage the app trades through. Each method is one Alpaca Broker API endpoint (named in its comment) with the same
// request and reply shapes (./types), so the simulator (SimBroker, BROKER=sim) and the real API (AlpacaBroker, BROKER=alpaca)
// are interchangeable. Routes never compute balances or enforce trading rules themselves: the broker does, and rejects what it
// doesn't allow with a BrokerError (./errors).
import type {
    ACHRelationship, Bank, CreateBankRequest, Account, AccountConfigurations, AccountCreationRequest, AccountDocument, AccountUpdateRequest, Activity,
    Asset, CalendarDay, Clock, CreateACHRelationshipRequest, CreateOrderRequest, CreateTransferRequest, ListActivitiesQuery,
    ListAssetsQuery, ListDocumentsQuery, ListOrdersQuery, ListTransfersQuery, OptionContract, OptionsApprovalRequest, OptionsApprovalResponse, Order, OwnerDocumentUploadRequest,
    PortfolioHistory, PortfolioHistoryQuery, Position, TradeAccount, Transfer, UpdateOrderRequest, CreateLocateRequest, ListLocateQuotesResponse,
    ListLocatesResponse, Locate
} from "./types";

// An event from one of the broker's streams, in the stream's own shape. Events are ordered per account by their ULID id; a
// consumer stores the last id it handled and resumes after it (Alpaca's since_ulid), and must tolerate a repeat.
export type BrokerEventStream = "trades" | "accounts" | "transfers" | "nta";
export interface BrokerEvent<T = unknown> {
    id: string;
    stream: BrokerEventStream;
    accountId: string;
    at: string;
    payload: T;
}

export interface Broker {
    // Accounts: POST /v1/accounts, GET and PATCH /v1/accounts/{id}, POST /v1/accounts/{id}/actions/close
    createAccount(request: AccountCreationRequest): Promise<Account>;
    getAccount(accountId: string): Promise<Account>;
    updateAccount(accountId: string, update: AccountUpdateRequest): Promise<Account>;
    closeAccount(accountId: string): Promise<void>;
    // POST /v1/accounts/{id}/documents/upload, such as an ID asked for by an ACTION_REQUIRED review
    uploadDocuments(accountId: string, documents: OwnerDocumentUploadRequest[]): Promise<void>;

    // Trading account: GET /v1/trading/accounts/{id}/account, its configurations, and portfolio history
    getTradeAccount(accountId: string): Promise<TradeAccount>;
    getConfigurations(accountId: string): Promise<AccountConfigurations>;
    updateConfigurations(accountId: string, update: AccountConfigurations): Promise<AccountConfigurations>;
    getPortfolioHistory(accountId: string, query?: PortfolioHistoryQuery): Promise<PortfolioHistory>;

    // Assets and the market calendar: GET /v1/assets, /v1/assets/{symbol}, /v1/calendar, /v1/clock
    listAssets(query?: ListAssetsQuery): Promise<Asset[]>;
    getAsset(symbol: string): Promise<Asset>;
    getCalendar(start: string, end: string): Promise<CalendarDay[]>;
    getClock(): Promise<Clock>;

    // Orders: /v1/trading/accounts/{id}/orders (POST, GET, DELETE all), /orders/{order_id} (GET, PATCH replace, DELETE cancel),
    // /orders:by_client_order_id
    createOrder(accountId: string, request: CreateOrderRequest): Promise<Order>;
    listOrders(accountId: string, query?: ListOrdersQuery): Promise<Order[]>;
    getOrder(accountId: string, orderId: string): Promise<Order>;
    getOrderByClientOrderId(accountId: string, clientOrderId: string): Promise<Order>;
    replaceOrder(accountId: string, orderId: string, update: UpdateOrderRequest): Promise<Order>;
    cancelOrder(accountId: string, orderId: string): Promise<void>;
    cancelAllOrders(accountId: string): Promise<{ id: string; status: number }[]>;

    // Positions: /v1/trading/accounts/{id}/positions (GET, DELETE close all), /positions/{symbol} (GET, DELETE close)
    listPositions(accountId: string): Promise<Position[]>;
    getPosition(accountId: string, symbol: string): Promise<Position>;
    closePosition(accountId: string, symbol: string, size?: { qty?: string; percentage?: string }): Promise<Order>;

    // Locates for hard-to-borrow short sales: GET /v1/locates/quotes, POST and GET /v1/locates, GET /v1/locates/{locate_id} (Alpaca
    // offers them in the Trading API; the account they act on is the one given)
    listLocateQuotes(accountId: string, symbols: string[]): Promise<ListLocateQuotesResponse>;
    createLocate(accountId: string, request: CreateLocateRequest): Promise<Locate>;
    listLocates(accountId: string, query?: { status?: string; symbol?: string; limit?: number }): Promise<ListLocatesResponse>;
    getLocate(accountId: string, locateId: string): Promise<Locate>;

    // Options: exercise (POST /positions/{symbol}/exercise), approval (POST /v1/accounts/{id}/options/approval), contracts
    exerciseOption(accountId: string, symbol: string): Promise<void>;
    requestOptionsApproval(accountId: string, request: OptionsApprovalRequest): Promise<OptionsApprovalResponse>;
    // GET /v1/accounts/options/approvals?account_id=, newest first
    listOptionsApprovals(accountId: string): Promise<OptionsApprovalResponse[]>;
    listOptionContracts(query: { underlying_symbols?: string; expiration_date_gte?: string; expiration_date_lte?: string; type?: "call" | "put" }): Promise<OptionContract[]>;

    // The ledger: GET /v1/accounts/activities?account_id=
    listActivities(accountId: string, query?: ListActivitiesQuery): Promise<Activity[]>;

    // Funding: /v1/accounts/{id}/ach_relationships (POST, GET, DELETE) and /transfers (POST, GET, DELETE cancel)
    createAchRelationship(accountId: string, request: CreateACHRelationshipRequest): Promise<ACHRelationship>;
    listAchRelationships(accountId: string): Promise<ACHRelationship[]>;
    deleteAchRelationship(accountId: string, relationshipId: string): Promise<void>;
    createTransfer(accountId: string, request: CreateTransferRequest): Promise<Transfer>;
    listTransfers(accountId: string, query?: ListTransfersQuery): Promise<Transfer[]>;
    cancelTransfer(accountId: string, transferId: string): Promise<void>;
    // Banks to wire money out to: /v1/accounts/{id}/recipient_banks (POST, GET, DELETE)
    createRecipientBank(accountId: string, request: CreateBankRequest): Promise<Bank>;
    listRecipientBanks(accountId: string): Promise<Bank[]>;
    deleteRecipientBank(accountId: string, bankId: string): Promise<void>;

    // Documents: GET /v1/accounts/{id}/documents and /documents/{document_id}/download (a PDF, or HTML for the simulator's)
    listDocuments(accountId: string, query?: ListDocumentsQuery): Promise<AccountDocument[]>;
    downloadDocument(accountId: string, documentId: string): Promise<{ contentType: string; body: Uint8Array }>;

    // Events: the trade, account status, transfer status and non-trade activity streams (GET /v2/events/trades and the others),
    // resumed after sinceId. Returns a function that stops the subscription.
    subscribe(streams: BrokerEventStream[], handler: (event: BrokerEvent) => Promise<void>, sinceId?: string): () => void;
}

export type BrokerMode = "sim" | "alpaca";

// Which broker the app trades through (BROKER, default sim). AlpacaBroker is built last (Phase 11), so alpaca isn't accepted yet.
export const brokerMode = (): BrokerMode => {
    const mode = process.env.BROKER ?? "sim";
    if (mode !== "sim") throw new Error(`BROKER=${mode} isn't supported yet; only the simulator (BROKER=sim) is implemented`);
    return mode;
};
