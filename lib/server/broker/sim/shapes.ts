// The simulator's stored rows as Alpaca's reply objects. Pure, so the tests can check them against the OpenAPI spec.
import { createHash } from "node:crypto";
import { addDays, easternParts, marketStatus, sessionOn, settlementDate } from "../../../marketHours";
import { contractName, isOptionSymbol } from "../../../options";
import type { AssetRow } from "../../universe";
import type { ACHRelationship, Account, AccountConfigurations, Asset, Bank, CalendarDay, Clock, KYCResults, NonTradeActivity, OptionContract, OptionsApprovalResponse, Order, TradeActivity, Transfer } from "../types";

// A sim_accounts row as pg returns it (JSONB columns parsed)
export interface SimAccountRow {
    id: string;
    account_number: string;
    account_type: string;
    account_sub_type: string | null;
    status: string;
    status_due_at: Date | null;
    contact: Account["contact"];
    identity: Account["identity"];
    disclosures: Account["disclosures"];
    agreements: NonNullable<Account["agreements"]>;
    trusted_contact: Account["trusted_contact"] | null;
    // An IRA's beneficiaries (tax IDs masked)
    beneficiaries?: Record<string, unknown>[] | null;
    enabled_assets: string[];
    kyc_results: KYCResults | null;
    configurations: AccountConfigurations;
    options_approved_level: number;
    documents: { id: string; document_type: string; document_sub_type?: string; mime_type: string; created_at: string; size: number; sha256: string }[];
    trading_blocked: boolean;
    transfers_blocked: boolean;
    account_blocked: boolean;
    created_at: Date;
    updated_at: Date;
    closed_at: Date | null;
}

// The account as GET /v1/accounts/{id} returns it, with its KYC results and trading configurations (Alpaca's AccountExtended
// fields). last_equity comes from the ledger (Phase 3); until then it's 0.
export const toAccount = (row: SimAccountRow, lastEquity = "0"): Account & { kyc_results?: KYCResults; trading_configurations?: AccountConfigurations; account_sub_type?: "traditional" | "roth"; beneficiaries?: Record<string, unknown>[] } => ({
    id: row.id,
    account_number: row.account_number,
    account_type: row.account_type as Account["account_type"],
    ...(row.account_type === "ira" ? { account_sub_type: row.account_sub_type as "traditional" | "roth", beneficiaries: row.beneficiaries ?? [] } : {}),
    status: row.status as Account["status"],
    currency: "USD",
    created_at: row.created_at.toISOString(),
    last_equity: lastEquity,
    contact: row.contact,
    identity: row.identity,
    disclosures: row.disclosures,
    agreements: row.agreements,
    ...(row.trusted_contact ? { trusted_contact: row.trusted_contact } : {}),
    enabled_assets: row.enabled_assets as Account["enabled_assets"],
    documents: row.documents.map(({ id, document_type, document_sub_type, mime_type, created_at }) => ({
        id, document_type: document_type as NonNullable<Account["documents"]>[number]["document_type"], document_sub_type, mime_type, created_at
    })),
    ...(row.kyc_results ? { kyc_results: row.kyc_results } : {}),
    trading_configurations: row.configurations
});

// A stable UUID for an asset Alpaca hasn't given an ID (no Alpaca keys): a name-based UUID of its symbol
export const assetId = (symbol: string): string => {
    const hex = createHash("sha1").update(`ai-stocktrader:asset:${symbol}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
};

// Alpha Vantage's exchange names as Alpaca's
const EXCHANGES: Record<string, Asset["exchange"]> = {
    NYSE: "NYSE", NASDAQ: "NASDAQ", AMEX: "AMEX", "NYSE MKT": "AMEX", ARCA: "ARCA", "NYSE ARCA": "ARCA", NYSEARCA: "NYSEARCA", BATS: "BATS"
};

// An asset in the universe as Alpaca's Asset. Without Alpaca's flags it's tradable, fractionable, marginable, shortable and easy to
// borrow (unless hardToBorrow says otherwise, such as SIM_HTB_SYMBOLS), with the house maintenance requirement of 30%.
export const toAsset = (row: AssetRow, { hardToBorrow = row.borrowStatus === "hard_to_borrow" }: { hardToBorrow?: boolean } = {}): Asset => ({
    id: row.alpacaId ?? assetId(row.symbol),
    class: "us_equity",
    exchange: EXCHANGES[row.exchange.toUpperCase()] ?? "NYSE",
    symbol: row.symbol,
    name: row.name,
    status: "active",
    tradable: row.tradable ?? true,
    marginable: row.marginable ?? true,
    shortable: row.shortable ?? true,
    fractionable: row.fractionable ?? true,
    margin_requirement_long: String(row.marginRequirementLong ?? 30),
    margin_requirement_short: String(row.marginRequirementShort ?? 30),
    borrow_status: hardToBorrow ? "hard_to_borrow" : row.borrowStatus ?? "easy_to_borrow",
    attributes: row.attributes
} as Asset);

const hhmm = (date: Date) => date.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });

// The trading days from start to end ("YYYY-MM-DD") as GET /v1/calendar returns them, from lib/marketHours.ts (which has Alpaca's
// calendar registered when keys are set)
export const toCalendar = (start: string, end: string): CalendarDay[] => {
    const days: CalendarDay[] = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
        const session = sessionOn(day);
        if (!session) continue;
        days.push({
            date: day, open: hhmm(session.open), close: hhmm(session.close),
            session_open: hhmm(session.extendedOpen).replace(":", ""), session_close: hhmm(session.extendedClose).replace(":", ""),
            settlement_date: settlementDate(day)
        });
    }
    return days;
};

// GET /v1/clock: whether the regular session is open now, and the next open and close
export const toClock = (now: Date): Clock => {
    const status = marketStatus(now);
    const nextClose = status.nextClose ?? sessionOn(easternParts(new Date(status.nextOpen)).dateKey)!.close.toISOString();
    return { timestamp: now.toISOString(), is_open: status.open, next_open: status.nextOpen, next_close: nextClose };
};

// A sim_options_approvals row as Alpaca's reply
export const toOptionsApproval = (row: { id: string; account_id: string; requested_level: number; approved_level: number; status: string; created_at: Date; updated_at: Date }): OptionsApprovalResponse => ({
    id: row.id,
    account_id: row.account_id,
    requested_level: row.requested_level as OptionsApprovalResponse["requested_level"],
    approved_level: row.approved_level as OptionsApprovalResponse["approved_level"],
    status: row.status as OptionsApprovalResponse["status"],
    requester: "CORRESPONDENT",
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
});

const decimal = (value: string | number | null) => value === null ? null : String(Number(value));

// sim_ach_relationships, sim_recipient_banks, sim_transfers and sim_activities rows as pg returns them (NUMERIC as strings)
export interface SimAchRow {
    id: string; account_id: string; status: string; reason: string | null; account_owner_name: string; bank_account_type: "CHECKING" | "SAVINGS";
    bank_account_number: string; bank_routing_number: string; nickname: string | null; created_at: Date; updated_at: Date;
}
export interface SimBankRow {
    id: string; account_id: string; status: string; name: string; bank_code: string; bank_code_type: "ABA" | "BIC"; account_number: string; created_at: Date; updated_at: Date;
}
export interface SimTransferRow {
    id: string; account_id: string; type: "ach" | "wire"; direction: "INCOMING" | "OUTGOING"; status: string; amount: string; instant_amount: string;
    fee: string; relationship_id: string | null; bank_id: string | null; reason: string | null; sent_at: Date; complete_at: Date;
    return_at: Date | null; return_code: string | null; created_at: Date; updated_at: Date;
    // An IRA transfer's details: a contribution's tax_year; a distribution's reason, tax year and withholding
    ira?: { tax_year?: string; distribution_reason?: string; fed_withholding_pct?: string; fed_withholding_amount?: string; state_withholding_pct?: string; state_withholding_amount?: string } | null;
}
export interface SimActivityRow {
    id: string; account_id: string; activity_type: string; activity_sub_type: string | null; date: string; created_at: Date; net_amount: string;
    description: string; status: string; transfer_id: string | null; symbol: string | null; qty: string | null; per_share_amount: string | null;
    // A FILL's fields
    side?: "buy" | "sell" | null; price?: string | null; leaves_qty?: string | null; cum_qty?: string | null; realized_pl?: string | null;
    settle_date?: string | null; reason?: string | null; quote_time?: Date | null; fill_policy?: string | null; legacy_order_id?: number | null;
    order_id?: string | null;
}

// A sim_orders row as pg returns it (NUMERIC as strings)
export interface SimOrderRow {
    id: string; account_id: string; client_order_id: string; symbol: string; side: "buy" | "sell"; type: Order["type"] & string;
    time_in_force: Order["time_in_force"] & string; order_class: "simple" | "bracket" | "oco" | "oto" | "mleg"; position_intent: Order["position_intent"] | null;
    qty: string | null; notional: string | null; limit_price: string | null; stop_price: string | null; trail_price: string | null;
    trail_percent: string | null; hwm: string | null; extended_hours: boolean; status: string; filled_qty: string; filled_notional: string;
    filled_avg_price: string | null; parent_id: string | null; group_id: string | null; group_role: "entry" | "take_profit" | "stop_loss" | "leg" | null;
    ratio_qty?: number | null; buying_power_held?: string | null;
    replaces: string | null; replaced_by: string | null; stop_triggered_at: Date | null; expires_at: Date; reason: string | null;
    created_at: Date; updated_at: Date; submitted_at: Date; filled_at: Date | null; expired_at: Date | null; canceled_at: Date | null;
    failed_at: Date | null; replaced_at: Date | null; cancel_requested_at: Date | null; liquidation?: boolean;
}

const iso = (date: Date | null) => date === null ? null : date.toISOString();

// An order as the Broker API returns it, with its legs nested when given (GET .../orders?nested=true). A bracket or OTO leg waiting
// for its entry to fill is "held", as Alpaca reports it, although the spec's OrderStatus enum leaves that status out. qty is the
// shares ordered (null for a notional order), and a leg's qty follows its entry's fills.
export const toOrder = (row: SimOrderRow, { legs, assetId: id }: { legs?: SimOrderRow[]; assetId?: string } = {}): Order => ({
    id: row.id, client_order_id: row.client_order_id, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    submitted_at: row.submitted_at.toISOString(), filled_at: iso(row.filled_at), expired_at: iso(row.expired_at), canceled_at: iso(row.canceled_at),
    failed_at: iso(row.failed_at), replaced_at: iso(row.replaced_at), replaced_by: row.replaced_by, replaces: row.replaces,
    cancel_requested_at: iso(row.cancel_requested_at),
    asset_id: row.order_class === "mleg" ? "" : id ?? assetId(row.symbol), symbol: row.symbol,
    asset_class: row.order_class === "mleg" || isOptionSymbol(row.symbol) ? "us_option" : "us_equity",
    notional: decimal(row.notional), qty: decimal(row.qty), filled_qty: decimal(row.filled_qty)!, filled_avg_price: decimal(row.filled_avg_price),
    order_class: row.order_class, order_type: row.type, type: row.type, side: row.side, time_in_force: row.time_in_force,
    limit_price: decimal(row.limit_price), stop_price: decimal(row.stop_price), status: row.status as Order["status"], extended_hours: row.extended_hours,
    ...(row.position_intent ? { position_intent: row.position_intent } : {}),
    ...(row.trail_price !== null ? { trail_price: decimal(row.trail_price) } : {}), ...(row.trail_percent !== null ? { trail_percent: decimal(row.trail_percent) } : {}),
    hwm: decimal(row.hwm),
    ...(row.group_id ? { group_id: row.group_id } : {}), ...(row.group_role && row.group_role !== "leg" ? { group_role: row.group_role } : {}),
    ...(row.ratio_qty ? { ratio_qty: String(row.ratio_qty) } : {}),
    legs: legs && legs.length > 0 ? legs.map(leg => toLeg(leg, row.order_class === "mleg" ? assetId(leg.symbol) : id)) : null,
    commission: "0"
});

// A leg nested in its parent (Alpaca's OrderLeg: an order without cancel_requested_at or legs of its own)
const toLeg = (row: SimOrderRow, id?: string): NonNullable<Order["legs"]>[number] => {
    const leg: Order = toOrder(row, { assetId: id });
    delete leg.cancel_requested_at;
    delete leg.legs;
    return leg as NonNullable<Order["legs"]>[number];
};

// Account numbers are stored and returned masked (••••6789), like the simulator's tax IDs
export const toAchRelationship = (row: SimAchRow): ACHRelationship => ({
    id: row.id, account_id: row.account_id, status: row.status as ACHRelationship["status"], account_owner_name: row.account_owner_name,
    bank_account_type: row.bank_account_type, bank_account_number: row.bank_account_number, bank_routing_number: row.bank_routing_number,
    ...(row.nickname ? { nickname: row.nickname } : {}), created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString()
});

export const toBank = (row: SimBankRow): Bank => ({
    id: row.id, account_id: row.account_id, status: row.status as Bank["status"], name: row.name, bank_code: row.bank_code,
    bank_code_type: row.bank_code_type, account_number: row.account_number, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString()
});

export const toTransfer = (row: SimTransferRow): Transfer => ({
    id: row.id, account_id: row.account_id, type: row.type, direction: row.direction, status: row.status as Transfer["status"],
    amount: decimal(row.amount)!, requested_amount: decimal(row.amount), instant_amount: decimal(row.instant_amount)!, fee: decimal(row.fee),
    ...(row.relationship_id ? { relationship_id: row.relationship_id } : {}), ...(row.bank_id ? { bank_id: row.bank_id } : {}),
    reason: row.reason, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    ...(row.ira ? { ira: row.ira } : {}),
    // When the funds are expected: an incoming deposit's settlement, or an outgoing transfer's arrival
    expires_at: row.complete_at.toISOString()
});

// A fill as GET /v1/accounts/activities returns it (Alpaca's TradeActivity): a partial_fill while its order has shares left. Fills from
// before Phase 4 filled the app's mock orders, which have no UUID, so order_id is left out for them.
export const toFillActivity = (row: SimActivityRow): TradeActivity & { id: string; activity_type: "FILL"; account_id: string } => ({
    id: row.id, account_id: row.account_id, activity_type: "FILL", type: Number(row.leaves_qty ?? 0) > 0 ? "partial_fill" : "fill", transaction_time: row.created_at.toISOString(),
    ...(row.order_id ? { order_id: row.order_id } : {}),
    symbol: row.symbol ?? "", side: row.side ?? "buy", qty: decimal(row.qty)!, price: decimal(row.price ?? "0")!,
    cum_qty: decimal(row.cum_qty ?? row.qty)!, leaves_qty: decimal(row.leaves_qty ?? "0")!, order_status: Number(row.leaves_qty ?? 0) > 0 ? "partially_filled" : "filled"
});

// A non-trade activity as GET /v1/accounts/activities returns it
export const toActivity = (row: SimActivityRow): NonTradeActivity & { id: string; activity_type: string; account_id: string } => ({
    id: row.id, account_id: row.account_id, activity_type: row.activity_type, ...(row.activity_sub_type ? { activity_sub_type: row.activity_sub_type as NonTradeActivity["activity_sub_type"] } : {}),
    date: row.date, created_at: row.created_at.toISOString(), net_amount: decimal(row.net_amount)!, description: row.description,
    status: row.status as NonTradeActivity["status"], currency: "USD",
    ...(row.transfer_id ? { transfer_id: row.transfer_id } : {}), ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.qty ? { qty: decimal(row.qty)! } : {}), ...(row.per_share_amount ? { per_share_amount: decimal(row.per_share_amount)! } : {})
});

// A listed option contract as Alpaca's /v1/options/contracts returns it, from the chain (its id a name-based UUID, as assets without
// Alpaca's get; standard contracts only, 100 shares of the underlying)
export const toOptionContract = (contract: { symbol: string; underlying: string; expiration: string; type: "call" | "put"; strike: number; date: string; openInterest: number | null; mark: number | null; last: number | null }): OptionContract => ({
    id: assetId(contract.symbol), symbol: contract.symbol, name: contractName(contract.symbol), status: "active", tradable: true,
    expiration_date: contract.expiration, root_symbol: contract.underlying, underlying_symbol: contract.underlying, underlying_asset_id: assetId(contract.underlying),
    type: contract.type, style: "american", strike_price: String(contract.strike), multiplier: "100", size: "100", ppind: true,
    ...(contract.openInterest !== null ? { open_interest: String(contract.openInterest), open_interest_date: contract.date } : {}),
    ...(contract.last !== null || contract.mark !== null ? { close_price: String(contract.last ?? contract.mark), close_price_date: contract.date } : {})
});
