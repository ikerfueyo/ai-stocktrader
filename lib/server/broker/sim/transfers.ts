import "server-only";
import { contributionLimit, contributionTaxYears, distributionReasonError, distributionWithholding, type IraSubType } from "../../../ira";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../db";
import { BrokerError } from "../errors";
import { easternParts } from "../../../marketHours";
import { emitEvent } from "./accounts";
import {
    achTimeline, bankRequestError, instantAmount, maskAccountNumber, plannedReturn, relationshipRequestError, RETURN_REASONS, TRANSFER_FEES,
    transferRequestError, verifyRelationship, wireTimeline
} from "./funding";
import { toAchRelationship, toActivity, toBank, toFillActivity, toTransfer, type SimAchRow, type SimActivityRow, type SimBankRow, type SimTransferRow } from "./shapes";
import type { ACHRelationship, Activity, Bank, CreateACHRelationshipRequest, CreateBankRequest, CreateTransferRequest, ListActivitiesQuery, ListTransfersQuery, Transfer } from "../types";

// The simulator's money movement: Alpaca's ACH relationship, recipient bank, transfer and activity endpoints on the sim_* tables,
// with the timing and rules of ./funding.ts. Transfers advance when they're due, from the background job (advanceTransfers) and
// whenever an account's transfers or activities are read. Each completed movement posts an activity to the account's ledger
// (sim_activities): CSD for cash in, CSW for cash out, FEE for fees.

const VERIFY_SECONDS = Number(process.env.SIM_KYC_SECONDS ?? 5);
// IDs are UUIDs; anything else is refused before it reaches a query (Postgres would reject it as a server error)
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const invalid = (message: string) => new BrokerError(422, 42210000, message);
const forbidden = (message: string) => new BrokerError(403, 40310000, message);
const notFound = (what: string) => new BrokerError(404, 40410000, `${what} not found`);

const accountStatus = async (accountId: string) => {
    const { rows: [row] } = await pool.query<{ status: string; identity: { given_name: string; family_name: string; date_of_birth?: string }; account_type: string; account_sub_type: IraSubType | null }>(
        "SELECT status, identity, account_type, account_sub_type FROM sim_accounts WHERE id = $1", [accountId]
    );
    if (!row) throw notFound("account");
    return row;
};
const OPEN = ["ACTIVE", "ACCOUNT_UPDATED"];

// Alpaca's activity ID: the time to the millisecond and a UUID
export const activityId = (at: Date) => `${at.toISOString().replace(/\D/g, "").slice(0, 17)}::${randomUUID()}`;

// Posts an activity to the ledger, with its nta event
export const postActivity = async (db: PoolClient | typeof pool, activity: {
    accountId: string; type: string; subType?: string; netAmount: number; description: string; transferId?: string; at?: Date;
    symbol?: string; qty?: number; perShareAmount?: number;
    // What it's for, where a type covers several (backup withholding on dividends or on proceeds)
    reason?: string;
}): Promise<SimActivityRow> => {
    const at = activity.at ?? new Date();
    const { rows: [row] } = await db.query<SimActivityRow>(
        `INSERT INTO sim_activities (id, account_id, activity_type, activity_sub_type, "date", created_at, net_amount, description, transfer_id, symbol, qty, per_share_amount, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *, "date"::text AS "date"`,
        [activityId(at), activity.accountId, activity.type, activity.subType ?? null, easternParts(at).dateKey, at, activity.netAmount.toFixed(2), activity.description.slice(0, 255),
            activity.transferId ?? null, activity.symbol ?? null, activity.qty ?? null, activity.perShareAmount ?? null, activity.reason ?? null]
    );
    await emitEvent(activity.accountId, "nta", toActivity(row), at);
    return row;
};

// ACH relationships

// Verifies queued links that are due: approved, or rejected with the reason found when they were requested
const advanceRelationships = async (accountId: string | null, now = new Date()) => {
    await pool.query(
        `UPDATE sim_ach_relationships SET status = CASE WHEN reason IS NULL THEN 'APPROVED' ELSE 'REJECTED' END, status_due_at = NULL, updated_at = now()
         WHERE status = 'QUEUED' AND status_due_at <= $1 AND ($2::uuid IS NULL OR account_id = $2)`,
        [now, accountId]
    );
};

const relationshipShape = (row: SimAchRow) => {
    const shaped = toAchRelationship(row);
    // A queued link's planned rejection reason isn't shown until verification finishes
    return row.status === "QUEUED" ? shaped : { ...shaped, ...(row.reason ? { reason: row.reason } : {}) };
};

// POST /v1/accounts/{id}/ach_relationships: QUEUED, then verified a few seconds later (verifyRelationship). 409 while the account
// has another link that's queued or approved.
export const createAchRelationship = async (accountId: string, request: CreateACHRelationshipRequest): Promise<ACHRelationship> => {
    const account = await accountStatus(accountId);
    if (!OPEN.includes(account.status)) throw forbidden(`a bank can't be linked while the account is ${account.status}`);
    const error = relationshipRequestError(request);
    if (error) throw invalid(error);
    await advanceRelationships(accountId);
    const rejection = verifyRelationship(request.account_owner_name, account.identity, request.bank_account_number);
    try {
        const { rows: [row] } = await pool.query<SimAchRow>(
            `INSERT INTO sim_ach_relationships (id, account_id, status, status_due_at, reason, account_owner_name, bank_account_type, bank_account_number,
                                                bank_routing_number, nickname)
             VALUES ($1, $2, 'QUEUED', now() + make_interval(secs => $3), $4, $5, $6, $7, $8, $9) RETURNING *`,
            [randomUUID(), accountId, VERIFY_SECONDS, rejection, request.account_owner_name.trim(), request.bank_account_type,
                maskAccountNumber(request.bank_account_number), request.bank_routing_number.replace(/\D/g, ""), request.nickname?.trim() || null]
        );
        return relationshipShape(row);
    } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new BrokerError(409, 40910000, "the account already has an active bank link; remove it first");
        throw error;
    }
};

export const listAchRelationships = async (accountId: string): Promise<ACHRelationship[]> => {
    await advanceRelationships(accountId);
    const { rows } = await pool.query<SimAchRow>("SELECT * FROM sim_ach_relationships WHERE account_id = $1 AND status <> 'CANCELED' ORDER BY created_at DESC", [accountId]);
    return rows.map(relationshipShape);
};

// DELETE /v1/accounts/{id}/ach_relationships/{relationship_id}. A link with queued transfers can't be removed until they move on.
export const deleteAchRelationship = async (accountId: string, relationshipId: string): Promise<void> => {
    if (!isUuid(relationshipId)) throw notFound("ach relationship");
    const { rows: [queued] } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM sim_transfers WHERE relationship_id = $1 AND status IN ('QUEUED', 'SENT_TO_CLEARING')", [relationshipId]
    );
    if (Number(queued.count) > 0) throw invalid("the bank link has transfers in progress");
    const { rowCount } = await pool.query(
        "UPDATE sim_ach_relationships SET status = 'CANCELED', updated_at = now() WHERE id = $1 AND account_id = $2 AND status <> 'CANCELED'", [relationshipId, accountId]
    );
    if (!rowCount) throw notFound("ach relationship");
};

// Recipient banks (outgoing wires)

export const createRecipientBank = async (accountId: string, request: CreateBankRequest): Promise<Bank> => {
    const account = await accountStatus(accountId);
    if (!OPEN.includes(account.status)) throw forbidden(`a bank can't be added while the account is ${account.status}`);
    const error = bankRequestError(request);
    if (error) throw invalid(error);
    const { rows: [row] } = await pool.query<SimBankRow>(
        `INSERT INTO sim_recipient_banks (id, account_id, name, bank_code, bank_code_type, account_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [randomUUID(), accountId, request.name.trim(), request.bank_code.replace(/\D/g, ""), request.bank_code_type, maskAccountNumber(request.account_number)]
    );
    return toBank(row);
};

export const listRecipientBanks = async (accountId: string): Promise<Bank[]> =>
    (await pool.query<SimBankRow>("SELECT * FROM sim_recipient_banks WHERE account_id = $1 AND status <> 'CANCELED' ORDER BY created_at DESC", [accountId])).rows.map(toBank);

export const deleteRecipientBank = async (accountId: string, bankId: string): Promise<void> => {
    if (!isUuid(bankId)) throw notFound("bank");
    const { rowCount } = await pool.query("UPDATE sim_recipient_banks SET status = 'CANCELED', updated_at = now() WHERE id = $1 AND account_id = $2 AND status <> 'CANCELED'", [bankId, accountId]);
    if (!rowCount) throw notFound("bank");
};

// Transfers

const LIVE = "('QUEUED', 'APPROVAL_PENDING', 'PENDING', 'SENT_TO_CLEARING', 'APPROVED', 'COMPLETE')";

const transferEvent = (row: SimTransferRow, from: string) =>
    emitEvent(row.account_id, "transfers", { account_id: row.account_id, transfer_id: row.id, status_from: from, status_to: row.status });

// An IRA transfer's details (Alpaca's TransferIRADetails), or null for another account's. A contribution is for a tax year still open
// (the current one, or the prior one until April 15; the current one by default). A distribution needs a reason that fits the account's
// type and the owner's age, and withholds 10% federal unless the request elects otherwise, and any state percentage.
const iraDetailsFor = async (accountId: string, account: Awaited<ReturnType<typeof accountStatus>>, request: CreateTransferRequest, amount: number, today: string) => {
    const asked = (request as CreateTransferRequest & { ira?: { tax_year?: string | number; distribution_reason?: string; tax_withholding?: { fed_pct?: string | number; state_pct?: string | number } } }).ira;
    if (account.account_type !== "ira") {
        if (asked) throw invalid("ira is only for IRA accounts");
        return null;
    }
    const year = Number(today.slice(0, 4));
    if (request.direction === "INCOMING") {
        const taxYear = asked?.tax_year === undefined || asked.tax_year === "" ? year : Number(asked.tax_year);
        if (!contributionTaxYears(today).includes(taxYear)) throw invalid(`contributions for ${taxYear} aren't accepted now (open: ${contributionTaxYears(today).join(", ")})`);
        return { tax_year: String(taxYear) };
    }
    if (!asked?.distribution_reason) throw invalid("ira.distribution_reason is required for an IRA distribution");
    const { rows: [first] } = await pool.query<{ year: number | null }>(
        `SELECT MIN((ira->>'tax_year')::int) AS year FROM sim_transfers WHERE account_id = $1 AND direction = 'INCOMING' AND status IN ${LIVE}`, [accountId]
    );
    const problem = distributionReasonError(asked.distribution_reason, account.account_sub_type ?? "traditional", {
        dateOfBirth: account.identity.date_of_birth ?? "1900-01-01", day: today, firstContributionYear: first?.year ?? null
    });
    if (problem) throw invalid(problem);
    const pct = (value: string | number | undefined) => value === undefined || value === "" ? undefined : Number(value);
    let withholding;
    try {
        withholding = distributionWithholding(amount, { fedPct: pct(asked.tax_withholding?.fed_pct), statePct: pct(asked.tax_withholding?.state_pct) });
    } catch (error) {
        throw invalid((error as Error).message);
    }
    return {
        distribution_reason: asked.distribution_reason, tax_year: String(year),
        fed_withholding_pct: String(withholding.fedPct), fed_withholding_amount: withholding.fedAmount.toFixed(2),
        state_withholding_pct: String(withholding.statePct), state_withholding_amount: withholding.stateAmount.toFixed(2)
    };
};

// POST /v1/accounts/{id}/transfers. An ACH transfer needs an approved bank link; a wire goes out to a recipient bank (incoming wires
// can't be requested). An ACH deposit is credited at once up to the instant limit (instant_amount), the rest when it settles.
// Outgoing transfers need an ACTIVE account (Alpaca pauses them while updated details are reviewed). Until the simulator keeps the
// whole ledger (Phase 3), the caller checks that the account has the cash to withdraw.
export const createTransfer = async (accountId: string, request: CreateTransferRequest): Promise<Transfer> => {
    const account = await accountStatus(accountId);
    const outgoing = request.direction === "OUTGOING";
    if (outgoing ? account.status !== "ACTIVE" : !OPEN.includes(account.status)) {
        throw forbidden(`${outgoing ? "withdrawals" : "deposits"} aren't allowed while the account is ${account.status}`);
    }
    const today = easternParts(new Date()).dateKey;
    const { rows: [{ total }] } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM sim_transfers
         WHERE account_id = $1 AND "type" = 'ach' AND direction = $2 AND status IN ${LIVE} AND (created_at AT TIME ZONE 'America/New_York')::date = $3::date`,
        [accountId, request.direction, today]
    );
    const error = transferRequestError(request, { todayTotal: Number(total) });
    if (error) throw invalid(error);
    const amount = Number(request.amount);
    const ira = await iraDetailsFor(accountId, account, request, amount, today);
    if (request.transfer_type === "ach") {
        if (!isUuid(request.relationship_id)) throw invalid("relationship_id must be one of the account's bank links");
        await advanceRelationships(accountId);
        const { rows: [link] } = await pool.query<{ status: string }>("SELECT status FROM sim_ach_relationships WHERE id = $1 AND account_id = $2", [request.relationship_id, accountId]);
        if (!link) throw invalid("relationship_id must be one of the account's bank links");
        if (link.status !== "APPROVED") throw invalid(`the bank link is ${link.status.toLowerCase()}, not approved`);
    } else {
        if (!isUuid(request.bank_id)) throw invalid("bank_id must be one of the account's recipient banks");
        const { rows: [bank] } = await pool.query("SELECT 1 FROM sim_recipient_banks WHERE id = $1 AND account_id = $2 AND status = 'APPROVED'", [request.bank_id, accountId]);
        if (!bank) throw invalid("bank_id must be one of the account's recipient banks");
    }
    const now = new Date();
    const timeline = request.transfer_type === "ach" ? achTimeline(now) : wireTimeline(now);
    const returned = !outgoing && request.transfer_type === "ach" ? plannedReturn(amount, timeline.completeAt) : null;
    const fee = outgoing && request.transfer_type === "wire" ? TRANSFER_FEES.wireOutDomestic : 0;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        let instant = 0;
        if (!outgoing && request.transfer_type === "ach") {
            const { rows: [{ outstanding }] } = await client.query<{ outstanding: string }>(
                `SELECT COALESCE(SUM(instant_amount), 0) AS outstanding FROM sim_transfers
                 WHERE account_id = $1 AND direction = 'INCOMING' AND status IN ('QUEUED', 'SENT_TO_CLEARING')`, [accountId]
            );
            instant = instantAmount(amount, Number(outstanding));
        }
        const { rows: [row] } = await client.query<SimTransferRow>(
            `INSERT INTO sim_transfers (id, account_id, "type", direction, status, amount, instant_amount, fee, relationship_id, bank_id, sent_at, complete_at, return_at, return_code, ira)
             VALUES ($1, $2, $3, $4, 'QUEUED', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [randomUUID(), accountId, request.transfer_type, request.direction, amount.toFixed(2), instant.toFixed(2), fee.toFixed(2),
                request.transfer_type === "ach" ? request.relationship_id : null, request.transfer_type === "wire" ? request.bank_id : null,
                timeline.sentAt, timeline.completeAt, returned?.at ?? null, returned?.code ?? null, ira ? JSON.stringify(ira) : null]
        );
        if (instant > 0) await postActivity(client, { accountId, type: "CSD", netAmount: instant, description: `${ira ? `IRA contribution for ${ira.tax_year}` : "ACH deposit"} (credited instantly)`, transferId: row.id, at: now });
        await client.query("COMMIT");
        await transferEvent(row, "");
        return toTransfer(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Moves one transfer to its next status, posting its activities, in one database transaction
const step = async (row: SimTransferRow, to: string, activities: { type: string; subType?: string; netAmount: number; description: string; reason?: string }[], reason: string | null = null) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows: [updated] } = await client.query<SimTransferRow>(
            "UPDATE sim_transfers SET status = $2, reason = COALESCE($3, reason), updated_at = now() WHERE id = $1 AND status = $4 RETURNING *", [row.id, to, reason, row.status]
        );
        if (!updated) {
            await client.query("ROLLBACK");
            return;
        }
        for (const activity of activities) await postActivity(client, { accountId: row.account_id, transferId: row.id, ...activity });
        await client.query("COMMIT");
        await transferEvent(updated, row.status);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

const label = (row: SimTransferRow) => row.ira
    ? `${row.type === "ach" ? "ACH" : "Wire"} IRA ${row.direction === "INCOMING" ? `contribution for ${row.ira.tax_year}` : `distribution (${row.ira.distribution_reason})`}`
    : `${row.type === "ach" ? "ACH" : "Wire"} ${row.direction === "INCOMING" ? "deposit" : "withdrawal"}`;

// An IRA distribution leaves as what's paid out (CSW) and the tax withheld from it (WH: FWH federal, SWH state), which is remitted
const distributionDebits = (row: SimTransferRow, amount: number) => {
    const fed = Number(row.ira?.fed_withholding_amount ?? 0);
    const state = Number(row.ira?.state_withholding_amount ?? 0);
    return [
        { type: "CSW", netAmount: -Math.round((amount - fed - state) * 100) / 100, description: label(row) },
        ...(fed > 0 ? [{ type: "WH", subType: "FWH", netAmount: -fed, reason: "distribution", description: `Federal income tax withheld (${row.ira!.fed_withholding_pct}%) from an IRA distribution of $${amount.toFixed(2)}` }] : []),
        ...(state > 0 ? [{ type: "WH", subType: "SWH", netAmount: -state, reason: "distribution", description: `State income tax withheld (${row.ira!.state_withholding_pct}%) from an IRA distribution of $${amount.toFixed(2)}` }] : [])
    ];
};

// Advances every due transfer one step at a time until none is due: to clearing (an outgoing transfer's cash leaves the account,
// with any fee), complete (a deposit's cash arrives, less what was credited instantly), and returned (the deposit is taken back,
// with the return fee)
export const advanceTransfers = async (accountId: string | null = null, now = new Date()): Promise<number> => {
    let moved = 0;
    for (let round = 0; round < 3; round++) {
        const { rows } = await pool.query<SimTransferRow>(
            `SELECT * FROM sim_transfers WHERE ($2::uuid IS NULL OR account_id = $2) AND (
                 (status = 'QUEUED' AND sent_at <= $1) OR (status = 'SENT_TO_CLEARING' AND complete_at <= $1)
                 OR (status = 'COMPLETE' AND return_at IS NOT NULL AND return_at <= $1))
             ORDER BY created_at`,
            [now, accountId]
        );
        if (rows.length === 0) break;
        for (const row of rows) {
            const amount = Number(row.amount);
            if (row.status === "QUEUED") {
                const debits = row.direction === "OUTGOING"
                    ? [...(row.ira ? distributionDebits(row, amount) : [{ type: "CSW", netAmount: -amount, description: label(row) }]), ...(Number(row.fee) > 0 ? [{ type: "FEE", netAmount: -Number(row.fee), description: "Outgoing wire fee" }] : [])]
                    : [];
                await step(row, "SENT_TO_CLEARING", debits);
            } else if (row.status === "SENT_TO_CLEARING") {
                const remaining = amount - Number(row.instant_amount);
                await step(row, "COMPLETE", row.direction === "INCOMING" && remaining > 0 ? [{ type: "CSD", netAmount: remaining, description: label(row) }] : []);
            } else {
                const reason = `${row.return_code}: ${RETURN_REASONS[row.return_code!] ?? "Returned"}`;
                await step(row, "RETURNED", [
                    { type: "CSW", netAmount: -amount, description: `ACH deposit returned (${reason})` },
                    ...(TRANSFER_FEES.achReturn > 0 ? [{ type: "FEE", netAmount: -TRANSFER_FEES.achReturn, description: "Returned ACH fee" }] : [])
                ], reason);
            }
            moved++;
        }
    }
    await advanceRelationships(accountId, now);
    return moved;
};

// Development only: moves every in-progress transfer one step now (its next date set to now), ignoring the banking calendar, so the
// whole lifecycle can be tried in minutes
export const fastForwardTransfers = async (): Promise<number> => {
    await pool.query(
        `UPDATE sim_transfers SET sent_at = LEAST(sent_at, now()) WHERE status = 'QUEUED';
         UPDATE sim_transfers SET complete_at = LEAST(complete_at, now()) WHERE status = 'SENT_TO_CLEARING';
         UPDATE sim_transfers SET return_at = LEAST(return_at, now()) WHERE status = 'COMPLETE' AND return_at IS NOT NULL;`
    );
    return advanceTransfers();
};

// GET /v1/accounts/{id}/transfers, newest first
export const listTransfers = async (accountId: string, query: ListTransfersQuery = {}): Promise<Transfer[]> => {
    await advanceTransfers(accountId);
    const { rows } = await pool.query<SimTransferRow>(
        `SELECT * FROM sim_transfers WHERE account_id = $1 AND ($2::text IS NULL OR direction = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [accountId, query.direction ?? null, Math.min(Number(query.limit ?? 100), 500), Number(query.offset ?? 0)]
    );
    return rows.map(toTransfer);
};

// DELETE /v1/accounts/{id}/transfers/{transfer_id}: only while QUEUED; an instant credit is taken back
export const cancelTransfer = async (accountId: string, transferId: string): Promise<void> => {
    if (!isUuid(transferId)) throw notFound("transfer");
    await advanceTransfers(accountId);
    const { rows: [row] } = await pool.query<SimTransferRow>("SELECT * FROM sim_transfers WHERE id = $1 AND account_id = $2", [transferId, accountId]);
    if (!row) throw notFound("transfer");
    if (row.status !== "QUEUED") throw invalid(`a transfer that's ${row.status.toLowerCase().replaceAll("_", " ")} can't be canceled`);
    const instant = Number(row.instant_amount);
    await step(row, "CANCELED", instant > 0 ? [{ type: "CSW", netAmount: -instant, description: "Instant deposit credit reversed (deposit canceled)" }] : [], "Canceled by the customer");
};

// GET /v1/accounts/activities?account_id=, newest first (direction asc for oldest first), filtered by type and date: fills as trade
// activities, everything else as non-trade activities
export const listActivities = async (accountId: string, query: ListActivitiesQuery = {}): Promise<Activity[]> => {
    await advanceTransfers(accountId);
    const types = query.activity_types ? (Array.isArray(query.activity_types) ? query.activity_types : String(query.activity_types).split(",")) : null;
    const { rows } = await pool.query<SimActivityRow>(
        `SELECT *, "date"::text AS "date" FROM sim_activities
         WHERE account_id = $1 AND ($2::text[] IS NULL OR activity_type = ANY($2)) AND ($3::date IS NULL OR "date" = $3) AND ($4::date IS NULL OR "date" <= $4)
           AND ($5::date IS NULL OR "date" >= $5)
         ORDER BY created_at ${query.direction === "asc" ? "ASC" : "DESC"}, id LIMIT $6`,
        [accountId, types, query.date ?? null, query.until ?? null, query.after ?? null, Math.min(Number(query.page_size ?? 100), 1000)]
    );
    return rows.map(row => row.activity_type === "FILL" ? toFillActivity(row) : toActivity(row)) as Activity[];
};

// For the mock ledger until Phase 3: the accounts' ledger cash, what their queued withdrawals hold back before they're debited, and
// the instant deposit credit not yet settled (it can be traded with but not withdrawn)
export const ledgerCash = async (accountIds: string[]): Promise<{ cash: number; pendingOut: number; unsettledInstant: number }> => {
    if (accountIds.length === 0) return { cash: 0, pendingOut: 0, unsettledInstant: 0 };
    const [{ rows: [ledger] }, { rows: [pending] }] = await Promise.all([
        pool.query<{ cash: string }>("SELECT COALESCE(SUM(net_amount), 0) AS cash FROM sim_activities WHERE account_id = ANY($1)", [accountIds]),
        pool.query<{ out: string; instant: string }>(
            `SELECT COALESCE(SUM(CASE WHEN direction = 'OUTGOING' AND status = 'QUEUED' THEN amount + fee ELSE 0 END), 0) AS out,
                    COALESCE(SUM(CASE WHEN direction = 'INCOMING' AND status IN ('QUEUED', 'SENT_TO_CLEARING') THEN instant_amount ELSE 0 END), 0) AS instant
             FROM sim_transfers WHERE account_id = ANY($1)`, [accountIds]
        )
    ]);
    return { cash: Number(ledger.cash), pendingOut: Number(pending.out), unsettledInstant: Number(pending.instant) };
};

// GET /v1/accounts/ira_excess_contributions: each IRA's contributions per tax year (transfers that haven't been cancelled, rejected or
// returned) above the limit for the owner's age, as Alpaca checks it (it doesn't know about IRAs at other brokers, or income limits)
export const listIraExcessContributions = async () => {
    const { rows } = await pool.query<{ account_id: string; tax_year: string; total: string; date_of_birth: string | null }>(
        `SELECT t.account_id, t.ira->>'tax_year' AS tax_year, SUM(t.amount) AS total, s.identity->>'date_of_birth' AS date_of_birth
         FROM sim_transfers t JOIN sim_accounts s ON s.id = t.account_id
         WHERE s.account_type = 'ira' AND t.direction = 'INCOMING' AND t.status IN ${LIVE} AND t.ira ? 'tax_year'
         GROUP BY t.account_id, t.ira->>'tax_year', s.identity->>'date_of_birth'`
    );
    return rows.filter(row => Number(row.total) > contributionLimit(Number(row.tax_year), row.date_of_birth ?? "1900-01-01") + 0.005)
        .map(row => ({ account_id: row.account_id, tax_year: Number(row.tax_year), total_contribution_amount: Number(row.total) }));
};
