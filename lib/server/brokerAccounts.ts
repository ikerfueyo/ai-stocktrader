import "server-only";
import type { NextRequest } from "next/server";
import pool from "./db";
import { HttpError } from "./httpError";
import { getBroker } from "./broker";
import type { Account } from "./broker/types";
import { FINAL_ACCOUNT_STATUSES as FINAL_STATUSES } from "../accounts";
import type { BrokerAccountKind, BrokerAccountSummary } from "../types";

// Which brokerage accounts each user has (broker_accounts) and which one a request acts on: the account picked in the header's
// switcher (the active_account cookie, when it's one of the user's), else the newest open one. requireAccount guards the routes that
// trade or move money.

export { ACTIVE_ACCOUNT_COOKIE } from "./requestContext";
import { ACTIVE_ACCOUNT_COOKIE } from "./requestContext";

interface BrokerAccountRow {
    account_id: string;
    user_id: string;
    broker: string;
    kind: BrokerAccountKind;
    account_number: string;
    created_at: Date;
}

export { FINAL_ACCOUNT_STATUSES as FINAL_STATUSES } from "../accounts";

export const listAccountRows = async (userId: string): Promise<BrokerAccountRow[]> =>
    (await pool.query<BrokerAccountRow>("SELECT * FROM broker_accounts WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows;

// The user's accounts with their current status (the broker's), newest first, and which one is active
export const listAccounts = async (request: NextRequest, userId: string): Promise<BrokerAccountSummary[]> => {
    const rows = await listAccountRows(userId);
    const accounts = await Promise.all(rows.map(row => getBroker().getAccount(row.account_id)));
    const active = pickActive(request, rows, accounts);
    return rows.map((row, i) => ({
        accountId: row.account_id,
        accountNumber: row.account_number,
        kind: row.kind,
        status: accounts[i].status,
        createdAt: row.created_at.toISOString(),
        active: row.account_id === active?.account_id
    }));
};

// The cookie's account if it's the user's and not closed or rejected, else the newest open one, else the newest
const pickActive = (request: NextRequest, rows: BrokerAccountRow[], accounts: Account[]) => {
    const open = rows.filter((_, i) => !FINAL_STATUSES.includes(accounts[i].status));
    const chosen = request.cookies.get(ACTIVE_ACCOUNT_COOKIE)?.value;
    return open.find(({ account_id }) => account_id === chosen) ?? open[0] ?? rows[0] ?? null;
};

// The user's account by ID (404 when it isn't theirs)
export const findUserAccount = async (userId: string, accountId: string): Promise<BrokerAccountRow> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) throw new HttpError("Account not found", 404);
    const { rows: [row] } = await pool.query<BrokerAccountRow>("SELECT * FROM broker_accounts WHERE user_id = $1 AND account_id = $2", [userId, accountId]);
    if (!row) throw new HttpError("Account not found", 404);
    return row;
};

export type AccountPurpose = "trade" | "deposit" | "withdraw";

const PURPOSE_LABELS: Record<AccountPurpose, string> = { trade: "trade", deposit: "deposit", withdraw: "withdraw" };

// The active account, checked for what the request does (403 otherwise): trading and deposits need an ACTIVE account, or one whose
// updated details are under review (ACCOUNT_UPDATED); withdrawals need an ACTIVE one, since Alpaca restricts outgoing transfers
// during that review; trading also stops while the user suspends it (suspend_trade)
export const requireAccount = async (request: NextRequest, userId: string, purpose: AccountPurpose): Promise<{ accountId: string; account: Account }> => {
    const rows = await listAccountRows(userId);
    const accounts = await Promise.all(rows.map(row => getBroker().getAccount(row.account_id)));
    const row = pickActive(request, rows, accounts);
    if (!row) throw new HttpError("Open an account to trade or move money", 403);
    const account = accounts[rows.indexOf(row)];
    const allowed = purpose === "withdraw" ? ["ACTIVE"] : ["ACTIVE", "ACCOUNT_UPDATED"];
    if (!allowed.includes(account.status)) {
        const reason = account.status === "ACCOUNT_UPDATED" ? "while your updated details are being reviewed" : `while the account is ${account.status.toLowerCase().replaceAll("_", " ")}`;
        throw new HttpError(`You can't ${PURPOSE_LABELS[purpose]} ${reason}`, 403);
    }
    if (purpose === "trade" && (await getBroker().getConfigurations(row.account_id)).suspend_trade) {
        throw new HttpError("Trading is suspended on this account (Settings)", 403);
    }
    return { accountId: row.account_id, account };
};

// The client's IPv4 address for agreements (Alpaca requires one): the first X-Forwarded-For address, with local requests as
// 127.0.0.1
export const clientIp = (request: NextRequest): string => {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const ipv4 = forwarded.replace(/^::ffff:/, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4) ? ipv4 : "127.0.0.1";
};
