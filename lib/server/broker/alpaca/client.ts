import { maskTaxId } from "../../../kyc";
import { BrokerError } from "../errors";
import type { Broker, BrokerEvent, BrokerEventStream } from "../broker";
import type {
    Account, AccountConfigurations, AccountCreationRequest, AccountDocument, AccountUpdateRequest, ACHRelationship, Activity, Asset, Bank, CalendarDay, Clock,
    CreateACHRelationshipRequest, CreateBankRequest, CreateOrderRequest, CreateTransferRequest, ListActivitiesQuery, ListAssetsQuery, ListDocumentsQuery,
    ListOrdersQuery, ListTransfersQuery, OptionContract, OptionsApprovalRequest, OptionsApprovalResponse, Order, OwnerDocumentUploadRequest, PortfolioHistory,
    PortfolioHistoryQuery, Position, TradeAccount, Transfer, UpdateOrderRequest
} from "../types";
import type { AlpacaBrokerConfig } from "./config";
import { AlpacaHttp, type Query } from "./http";
import { subscribeToStreams, type SubscriptionOptions } from "./sse";

// The real brokerage (BROKER=alpaca): each Broker method is its Broker API endpoint (the paths in vendor/alpaca/broker-api.json),
// with Alpaca's request and reply shapes passed through as they are. What the adapter adds:
// - Tax IDs: an application's full SSN goes to Alpaca in the request and nowhere else (the routes don't store it, and nothing here
//   logs a body); accounts coming back have the tax ID masked to its last 4 digits and beneficiaries' to xxx-xx-xxxx, as the
//   simulator returns them, so no full SSN reaches the pages or the database even if Alpaca echoed one.
// - Lists Alpaca pages (option contracts, options approvals) are followed to the end, or to the limit asked for.
// - Trading configurations: the API has no GET of its own; they're the trading account's user_configurations (null until set).
// - Locates: Alpaca offers them in the Trading API only (per-account keys, not partner credentials), so they're refused as 501.
// - Documents: the download redirects to a pre-signed link, fetched without the bearer token.

const enc = encodeURIComponent;

// An account's tax IDs as the app may hold them
export const redactAccount = <T extends Account>(account: T): T => {
    const identity = account.identity ? { ...account.identity, ...(account.identity.tax_id ? { tax_id: maskTaxId(account.identity.tax_id) } : {}) } : account.identity;
    const withBeneficiaries = account as T & { beneficiaries?: { tax_id?: string }[] | null };
    const beneficiaries = withBeneficiaries.beneficiaries?.map(beneficiary => ({ ...beneficiary, ...(beneficiary.tax_id ? { tax_id: "xxx-xx-xxxx" } : {}) }));
    return { ...account, identity, ...(beneficiaries ? { beneficiaries } : {}) };
};

export class AlpacaBroker implements Broker {
    readonly http: AlpacaHttp;

    constructor(config: AlpacaBrokerConfig, private readonly subscription: SubscriptionOptions = {}) {
        this.http = new AlpacaHttp(config);
    }

    private get<T>(path: string, query?: Query) {
        return this.http.json<T>("GET", path, { query });
    }
    private trading(accountId: string, path = "") {
        return `/v1/trading/accounts/${enc(accountId)}${path}`;
    }

    // Accounts
    async createAccount(request: AccountCreationRequest) {
        return redactAccount(await this.http.json<Account>("POST", "/v1/accounts", { body: request }));
    }
    async getAccount(accountId: string) {
        return redactAccount(await this.get<Account>(`/v1/accounts/${enc(accountId)}`));
    }
    async updateAccount(accountId: string, update: AccountUpdateRequest) {
        return redactAccount(await this.http.json<Account>("PATCH", `/v1/accounts/${enc(accountId)}`, { body: update }));
    }
    async closeAccount(accountId: string) {
        await this.http.json("POST", `/v1/accounts/${enc(accountId)}/actions/close`);
    }
    async uploadDocuments(accountId: string, documents: OwnerDocumentUploadRequest[]) {
        await this.http.json("POST", `/v1/accounts/${enc(accountId)}/documents/upload`, { body: documents });
    }

    // Trading account
    getTradeAccount(accountId: string) {
        return this.get<TradeAccount>(this.trading(accountId, "/account"));
    }
    async getConfigurations(accountId: string): Promise<AccountConfigurations> {
        const account = await this.getTradeAccount(accountId) as TradeAccount & { user_configurations?: AccountConfigurations | null };
        return account.user_configurations ?? {};
    }
    updateConfigurations(accountId: string, update: AccountConfigurations) {
        return this.http.json<AccountConfigurations>("PATCH", this.trading(accountId, "/account/configurations"), { body: update });
    }
    getPortfolioHistory(accountId: string, query: PortfolioHistoryQuery = {}) {
        return this.get<PortfolioHistory>(this.trading(accountId, "/account/portfolio/history"), query as Query);
    }

    // Assets and the calendar
    listAssets(query: ListAssetsQuery = {}) {
        return this.get<Asset[]>("/v1/assets", query as Query);
    }
    getAsset(symbol: string) {
        return this.get<Asset>(`/v1/assets/${enc(symbol)}`);
    }
    getCalendar(start: string, end: string) {
        return this.get<CalendarDay[]>("/v1/calendar", { start, end });
    }
    getClock() {
        return this.get<Clock>("/v1/clock");
    }

    // Orders
    createOrder(accountId: string, request: CreateOrderRequest) {
        return this.http.json<Order>("POST", this.trading(accountId, "/orders"), { body: request });
    }
    listOrders(accountId: string, query: ListOrdersQuery = {}) {
        return this.get<Order[]>(this.trading(accountId, "/orders"), query as Query);
    }
    getOrder(accountId: string, orderId: string) {
        return this.get<Order>(this.trading(accountId, `/orders/${enc(orderId)}`));
    }
    getOrderByClientOrderId(accountId: string, clientOrderId: string) {
        return this.get<Order>(this.trading(accountId, "/orders:by_client_order_id"), { client_order_id: clientOrderId });
    }
    replaceOrder(accountId: string, orderId: string, update: UpdateOrderRequest) {
        return this.http.json<Order>("PATCH", this.trading(accountId, `/orders/${enc(orderId)}`), { body: update });
    }
    async cancelOrder(accountId: string, orderId: string) {
        await this.http.json("DELETE", this.trading(accountId, `/orders/${enc(orderId)}`));
    }
    async cancelAllOrders(accountId: string) {
        // 207 Multi-Status: each order's own status
        const results = await this.http.json<{ id: string; status: number }[] | undefined>("DELETE", this.trading(accountId, "/orders"));
        return (results ?? []).map(({ id, status }) => ({ id, status }));
    }

    // Positions
    listPositions(accountId: string) {
        return this.get<Position[]>(this.trading(accountId, "/positions"));
    }
    getPosition(accountId: string, symbol: string) {
        return this.get<Position>(this.trading(accountId, `/positions/${enc(symbol)}`));
    }
    closePosition(accountId: string, symbol: string, size: { qty?: string; percentage?: string } = {}) {
        return this.http.json<Order>("DELETE", this.trading(accountId, `/positions/${enc(symbol)}`), { query: size });
    }

    // Locates
    private noLocates(): never {
        throw new BrokerError(501, 50110000, "Locates for hard-to-borrow short sales aren't offered through Alpaca's Broker API");
    }
    listLocateQuotes = async (): Promise<never> => this.noLocates();
    createLocate = async (): Promise<never> => this.noLocates();
    listLocates = async (): Promise<never> => this.noLocates();
    getLocate = async (): Promise<never> => this.noLocates();

    // Options
    exerciseOption(accountId: string, symbol: string, request: { qty?: string } = {}) {
        return this.http.json<{ qty_exercised: string; qty_remaining: string }>("POST", this.trading(accountId, `/positions/${enc(symbol)}/exercise`), { body: request });
    }
    async doNotExercise(accountId: string, symbol: string) {
        await this.http.json("POST", this.trading(accountId, `/positions/${enc(symbol)}/do-not-exercise`));
    }
    requestOptionsApproval(accountId: string, request: OptionsApprovalRequest) {
        return this.http.json<OptionsApprovalResponse>("POST", `/v1/accounts/${enc(accountId)}/options/approval`, { body: request });
    }
    async listOptionsApprovals(accountId: string) {
        const approvals: OptionsApprovalResponse[] = [];
        let pageToken: string | undefined;
        do {
            const page = await this.get<{ options_approvals?: OptionsApprovalResponse[]; next_page_token?: string | null }>("/v1/accounts/options/approvals", { account_id: accountId, page_token: pageToken });
            approvals.push(...page.options_approvals ?? []);
            pageToken = page.next_page_token ?? undefined;
        } while (pageToken);
        return approvals.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    }
    async listOptionContracts(query: Parameters<Broker["listOptionContracts"]>[0]) {
        // Alpaca's default page is 100 and its largest 10,000
        const limit = Math.min(10000, Number(query.limit ?? 100) || 100);
        const contracts: OptionContract[] = [];
        let pageToken: string | undefined;
        do {
            const page = await this.get<{ option_contracts?: OptionContract[]; next_page_token?: string | null }>("/v1/options/contracts", { ...query, limit: limit - contracts.length, page_token: pageToken });
            contracts.push(...page.option_contracts ?? []);
            pageToken = page.next_page_token ?? undefined;
        } while (pageToken && contracts.length < limit);
        return contracts.slice(0, limit);
    }
    getOptionContract(symbol: string) {
        return this.get<OptionContract>(`/v1/options/contracts/${enc(symbol)}`);
    }

    // IRAs
    async listIraExcessContributions() {
        return (await this.get<{ account_id?: string; tax_year?: number; total_contribution_amount?: number }[]>("/v1/accounts/ira_excess_contributions") ?? [])
            .map(({ account_id, tax_year, total_contribution_amount }) => ({ account_id: account_id ?? "", tax_year: Number(tax_year), total_contribution_amount: Number(total_contribution_amount) }));
    }

    // The ledger
    listActivities(accountId: string, query: ListActivitiesQuery = {}) {
        return this.get<Activity[]>("/v1/accounts/activities", { ...query as Query, account_id: accountId });
    }

    // Funding. A bank is linked with a Plaid processor token (processor_token alone) or with its routing and account numbers.
    createAchRelationship(accountId: string, request: CreateACHRelationshipRequest) {
        return this.http.json<ACHRelationship>("POST", `/v1/accounts/${enc(accountId)}/ach_relationships`, { body: request });
    }
    listAchRelationships(accountId: string) {
        return this.get<ACHRelationship[]>(`/v1/accounts/${enc(accountId)}/ach_relationships`);
    }
    async deleteAchRelationship(accountId: string, relationshipId: string) {
        await this.http.json("DELETE", `/v1/accounts/${enc(accountId)}/ach_relationships/${enc(relationshipId)}`);
    }
    createTransfer(accountId: string, request: CreateTransferRequest) {
        return this.http.json<Transfer>("POST", `/v1/accounts/${enc(accountId)}/transfers`, { body: request });
    }
    listTransfers(accountId: string, query: ListTransfersQuery = {}) {
        return this.get<Transfer[]>(`/v1/accounts/${enc(accountId)}/transfers`, query as Query);
    }
    async cancelTransfer(accountId: string, transferId: string) {
        await this.http.json("DELETE", `/v1/accounts/${enc(accountId)}/transfers/${enc(transferId)}`);
    }
    createRecipientBank(accountId: string, request: CreateBankRequest) {
        return this.http.json<Bank>("POST", `/v1/accounts/${enc(accountId)}/recipient_banks`, { body: request });
    }
    listRecipientBanks(accountId: string) {
        return this.get<Bank[]>(`/v1/accounts/${enc(accountId)}/recipient_banks`);
    }
    async deleteRecipientBank(accountId: string, bankId: string) {
        await this.http.json("DELETE", `/v1/accounts/${enc(accountId)}/recipient_banks/${enc(bankId)}`);
    }

    // Documents
    listDocuments(accountId: string, query: ListDocumentsQuery = {}) {
        return this.get<AccountDocument[]>(`/v1/accounts/${enc(accountId)}/documents`, query as Query);
    }
    async downloadDocument(accountId: string, documentId: string) {
        const response = await this.http.send("GET", `/v1/accounts/${enc(accountId)}/documents/${enc(documentId)}/download`, { redirect: "manual", headers: { Accept: "*/*" } });
        const location = response.headers.get("location");
        const file = location ? await (this.http.config.fetch ?? fetch)(new URL(location, this.http.config.apiUrl), { signal: AbortSignal.timeout(this.http.config.timeoutMs ?? 30000) }) : response;
        if (!file.ok) throw new BrokerError(file.status === 404 ? 404 : 502, file.status === 404 ? 40410000 : 50210000, `document ${documentId} couldn't be downloaded (${file.status})`);
        return { contentType: file.headers.get("content-type") ?? "application/pdf", body: new Uint8Array(await file.arrayBuffer()) };
    }

    // Events
    subscribe(streams: BrokerEventStream[], handler: (event: BrokerEvent) => Promise<void>, sinceId?: string) {
        return subscribeToStreams(this.http, streams, handler, sinceId, this.subscription);
    }
}
