// The simulator's stored rows as Alpaca's reply objects. Pure, so the tests can check them against the OpenAPI spec.
import { createHash } from "node:crypto";
import { addDays, easternParts, marketStatus, sessionOn, settlementDate } from "../../../marketHours";
import type { AssetRow } from "../../universe";
import type { ACHRelationship, Account, AccountConfigurations, Asset, Bank, CalendarDay, Clock, KYCResults, NonTradeActivity, OptionsApprovalResponse, Transfer } from "../types";

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
export const toAccount = (row: SimAccountRow, lastEquity = "0"): Account & { kyc_results?: KYCResults; trading_configurations?: AccountConfigurations } => ({
    id: row.id,
    account_number: row.account_number,
    account_type: row.account_type as Account["account_type"],
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

// An asset in the universe as Alpaca's Asset. Without Alpaca's flags it's tradable, fractionable and marginable, isn't shortable,
// and has the house margin requirements' 30% (refined in Phase 5).
export const toAsset = (row: AssetRow): Asset => ({
    id: row.alpacaId ?? assetId(row.symbol),
    class: "us_equity",
    exchange: EXCHANGES[row.exchange.toUpperCase()] ?? "NYSE",
    symbol: row.symbol,
    name: row.name,
    status: "active",
    tradable: row.tradable ?? true,
    marginable: row.marginable ?? true,
    shortable: row.shortable ?? false,
    fractionable: row.fractionable ?? true,
    margin_requirement_long: String(row.marginRequirementLong ?? 30),
    margin_requirement_short: String(row.marginRequirementShort ?? 30),
    ...(row.borrowStatus ? { borrow_status: row.borrowStatus } : {}),
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
}
export interface SimActivityRow {
    id: string; account_id: string; activity_type: string; activity_sub_type: string | null; date: string; created_at: Date; net_amount: string;
    description: string; status: string; transfer_id: string | null; symbol: string | null; qty: string | null; per_share_amount: string | null;
}

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
    // When the funds are expected: an incoming deposit's settlement, or an outgoing transfer's arrival
    expires_at: row.complete_at.toISOString()
});

// A non-trade activity as GET /v1/accounts/activities returns it
export const toActivity = (row: SimActivityRow): NonTradeActivity & { id: string; activity_type: string; account_id: string } => ({
    id: row.id, account_id: row.account_id, activity_type: row.activity_type, ...(row.activity_sub_type ? { activity_sub_type: row.activity_sub_type as NonTradeActivity["activity_sub_type"] } : {}),
    date: row.date, created_at: row.created_at.toISOString(), net_amount: decimal(row.net_amount)!, description: row.description,
    status: row.status as NonTradeActivity["status"], currency: "USD",
    ...(row.transfer_id ? { transfer_id: row.transfer_id } : {}), ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.qty ? { qty: decimal(row.qty)! } : {}), ...(row.per_share_amount ? { per_share_amount: decimal(row.per_share_amount)! } : {})
});
