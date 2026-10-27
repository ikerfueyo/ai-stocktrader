// The simulator's stored rows as Alpaca's reply objects. Pure, so the tests can check them against the OpenAPI spec.
import { createHash } from "node:crypto";
import { addDays, easternParts, marketStatus, sessionOn, settlementDate } from "../../../marketHours";
import type { AssetRow } from "../../universe";
import type { Account, AccountConfigurations, Asset, CalendarDay, Clock, KYCResults, OptionsApprovalResponse } from "../types";

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
