import "server-only";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { monotonicFactory } from "ulid";
import pool from "../../db";
import { BrokerError } from "../errors";
import { maskTaxId, validateApplication, type AccountApplication, type AgreementName } from "../../../kyc";
import { easternParts } from "../../../marketHours";
import { configurationError, decideOptionsApproval, defaultConfigurations, nextReviewStep, submittedDueAt, updateNeedsReview } from "./kyc";
import { toAccount, toOptionsApproval, type SimAccountRow } from "./shapes";
import type { BrokerEventStream } from "../broker";
import type { Account, AccountConfigurations, AccountCreationRequest, AccountStatus, AccountUpdateRequest, OptionsApprovalResponse, OwnerDocumentUploadRequest } from "../types";

// The simulator's accounts: Alpaca's account endpoints on the sim_accounts table, with the review steps of ./kyc.ts. Reviews advance
// when they're due, both from the background job (advanceAccounts) and whenever an account is read, so a polling client sees them
// promptly.

const nextUlid = monotonicFactory();
const OPTIONS_REVIEW_SECONDS = Number(process.env.SIM_KYC_SECONDS ?? 5);

// Appends an event to one of the simulator's streams (sim_events), like Alpaca's SSE streams
export const emitEvent = async (accountId: string, stream: BrokerEventStream, payload: Record<string, unknown>, at = new Date()) => {
    const id = nextUlid(at.getTime());
    await pool.query("INSERT INTO sim_events (id, account_id, stream, at, payload) VALUES ($1, $2, $3, $4, $5)",
        [id, accountId, stream, at, JSON.stringify({ ...payload, event_ulid: id, at: at.toISOString() })]);
    return id;
};

const statusEvent = (row: Pick<SimAccountRow, "id" | "account_number">, from: string | null, to: string, extra: Record<string, unknown> = {}) =>
    emitEvent(row.id, "accounts", { account_id: row.id, account_number: row.account_number, status_from: from ?? "", status_to: to, ...extra });

const agreementNames = (agreements: { agreement?: string }[] | undefined) => (agreements ?? []).map(({ agreement }) => agreement as AgreementName);

// Checks a request with the same rules as the onboarding form (lib/kyc.ts), less the parts the app keeps itself (the W-9 and the
// delivered disclosures) and the options level, which is asked for separately. An update is checked against the stored details,
// whose tax ID is masked (and can't change), so its tax ID isn't checked.
const requestErrors = (request: AccountCreationRequest | (Account & { identity: NonNullable<Account["identity"]> }), { storedTaxId = false } = {}): string[] => {
    const application = {
        contact: { phone_number: "", street_address: [], city: "", state: "", postal_code: "", ...request.contact, country: request.contact?.country ?? "" },
        identity: { ...request.identity },
        disclosures: { ...request.disclosures },
        trusted_contact: request.trusted_contact,
        agreements: agreementNames(request.agreements),
        options_level: 1,
        w9: { certified: true, backup_withholding: false },
        disclosures_delivered: { form_crs: true, privacy_notice: true }
    } as unknown as AccountApplication;
    return Object.entries(validateApplication(application, easternParts(new Date()).dateKey))
        .filter(([field]) => !(storedTaxId && field === "identity.tax_id"))
        .map(([field, message]) => `${field}: ${message}`);
};

const invalid = (errors: string[]) => new BrokerError(422, 42210000, errors.join("; "));
const notFound = (accountId: string) => new BrokerError(404, 40410000, `account not found for ${accountId}`);

const loadRow = async (accountId: string): Promise<SimAccountRow> => {
    const { rows: [row] } = await pool.query<SimAccountRow>("SELECT * FROM sim_accounts WHERE id = $1", [accountId]);
    if (!row) throw notFound(accountId);
    return row;
};

// Applies every review step that's due (an account can go SUBMITTED to APPROVED to ACTIVE at once), with an event for each
const advance = async (row: SimAccountRow, now = new Date()): Promise<SimAccountRow> => {
    let current = row;
    for (let step = 0; step < 4; step++) {
        const next = nextReviewStep({
            status: current.status as AccountStatus,
            dueAt: current.status_due_at,
            documentsUploaded: current.documents.length > 0
        }, { identity: current.identity as AccountApplication["identity"], disclosures: current.disclosures as AccountApplication["disclosures"] }, now);
        if (!next) break;
        const { rows: [updated] } = await pool.query<SimAccountRow>(
            `UPDATE sim_accounts SET status = $2, status_due_at = $3, kyc_results = COALESCE($4, kyc_results), updated_at = now()
             WHERE id = $1 AND status = $5 RETURNING *`,
            [current.id, next.status, next.dueAt, next.kyc_results === undefined ? null : JSON.stringify(next.kyc_results), current.status]
        );
        if (!updated) return loadRow(current.id);
        await statusEvent(updated, current.status, next.status, next.kyc_results ? { kyc_results: next.kyc_results } : {});
        current = updated;
    }
    return current;
};

// Decides the account's options approval requests that are due, raising its approved level (and enabling options). Requests made
// with the application wait until the account is active.
const advanceOptionsApprovals = async (row: SimAccountRow, now = new Date()) => {
    if (row.status !== "ACTIVE" && row.status !== "ACCOUNT_UPDATED") return;
    const { rows } = await pool.query<{ id: string; requested_level: number }>(
        "SELECT id, requested_level FROM sim_options_approvals WHERE account_id = $1 AND status = 'PENDING' AND due_at <= $2", [row.id, now]
    );
    for (const request of rows) {
        const { status, approvedLevel } = decideOptionsApproval(request.requested_level, {
            agreements: agreementNames(row.agreements),
            stocksExperience: row.identity?.investment_experience_with_stocks,
            optionsExperience: row.identity?.investment_experience_with_options
        });
        await pool.query("UPDATE sim_options_approvals SET status = $2, approved_level = $3, updated_at = now() WHERE id = $1", [request.id, status, approvedLevel]);
        if (approvedLevel > row.options_approved_level) {
            await pool.query(
                `UPDATE sim_accounts SET options_approved_level = $2, enabled_assets = (SELECT ARRAY(SELECT DISTINCT unnest(enabled_assets || '{us_option}'))),
                     configurations = jsonb_set(configurations, '{max_options_trading_level}', to_jsonb($2::int)), updated_at = now() WHERE id = $1`,
                [row.id, approvedLevel]
            );
        }
        await statusEvent(row, row.status, row.status, { options: { status, approved_level: approvedLevel, requested_level: request.requested_level } });
    }
};

// Advances every account with a review step or options decision due (the background job's sim-accounts job)
export const advanceAccounts = async (now = new Date()): Promise<number> => {
    const { rows } = await pool.query<SimAccountRow>(
        `SELECT * FROM sim_accounts
         WHERE (status IN ('SUBMITTED', 'APPROVAL_PENDING', 'ACCOUNT_UPDATED') AND status_due_at <= $1) OR status = 'APPROVED'
            OR (status = 'ACTION_REQUIRED' AND jsonb_array_length(documents) > 0)
            OR id IN (SELECT account_id FROM sim_options_approvals WHERE status = 'PENDING' AND due_at <= $1)`,
        [now]
    );
    for (const row of rows) {
        await advanceOptionsApprovals(await advance(row, now), now);
    }
    return rows.length;
};

const readRow = async (accountId: string) => {
    const row = await advance(await loadRow(accountId));
    await advanceOptionsApprovals(row);
    return loadRow(accountId);
};

const newAccountNumber = () => `9${String(randomInt(0, 1e8)).padStart(8, "0")}`;

// POST /v1/accounts: validates the application, stores it with the tax ID masked, and starts the review (SUBMITTED). Trading
// configurations start from the agreements signed (a margin agreement makes a margin account).
export const createAccount = async (request: AccountCreationRequest): Promise<Account> => {
    const errors = requestErrors(request);
    if (!request.contact || !request.identity || !request.disclosures) errors.unshift("contact, identity and disclosures are required");
    if (errors.length > 0) throw invalid(errors);
    const identity = { ...request.identity!, tax_id: maskTaxId(request.identity!.tax_id ?? "") };
    const agreements = agreementNames(request.agreements);
    const enabledAssets = [...new Set(["us_equity", ...(request.enabled_assets ?? [])])];
    const now = new Date();
    for (let attempt = 0; ; attempt++) {
        try {
            const { rows: [row] } = await pool.query<SimAccountRow>(
                `INSERT INTO sim_accounts (id, account_number, account_type, status, status_due_at, contact, identity, disclosures, agreements,
                                           trusted_contact, enabled_assets, configurations)
                 VALUES ($1, $2, 'trading', 'SUBMITTED', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [randomUUID(), newAccountNumber(), submittedDueAt(now), JSON.stringify(request.contact), JSON.stringify(identity),
                    JSON.stringify(request.disclosures), JSON.stringify(request.agreements), request.trusted_contact ? JSON.stringify(request.trusted_contact) : null,
                    enabledAssets.filter(asset => asset !== "us_option"), JSON.stringify({ ...defaultConfigurations(agreements), ...(request.trading_configurations ?? {}), max_options_trading_level: 0 })]
            );
            await statusEvent(row, null, "SUBMITTED");
            return toAccount(row);
        } catch (error) {
            // A clash of the random account number; try another
            if ((error as { code?: string }).code !== "23505" || attempt >= 4) throw error;
        }
    }
};

export const getAccount = async (accountId: string): Promise<Account> => toAccount(await readRow(accountId));

// PATCH /v1/accounts/{id}: contact, identity (not the tax ID or date of birth), disclosures, trusted contact and added agreements.
// Changes to the details Alpaca reviews move an active account to ACCOUNT_UPDATED until the review passes.
export const updateAccount = async (accountId: string, update: AccountUpdateRequest): Promise<Account> => {
    const row = await readRow(accountId);
    if (row.status !== "ACTIVE" && row.status !== "ACCOUNT_UPDATED") throw new BrokerError(422, 42210000, `an account in status ${row.status} can't be updated`);
    if (update.identity && ("tax_id" in update.identity || "date_of_birth" in update.identity)) {
        throw new BrokerError(422, 42210000, "the tax ID and date of birth can't be changed");
    }
    const contact = update.contact ? { ...row.contact, ...update.contact } : row.contact;
    const identity = update.identity ? { ...(row.identity as object), ...(update.identity as object) } as Account["identity"] : row.identity;
    const disclosures = update.disclosures ? { ...row.disclosures, ...update.disclosures } : row.disclosures;
    const trusted = update.trusted_contact === undefined ? row.trusted_contact : update.trusted_contact;
    const signed = new Map(row.agreements.map(agreement => [agreement.agreement, agreement]));
    for (const agreement of update.agreements ?? []) if (!signed.has(agreement.agreement)) signed.set(agreement.agreement, agreement);
    const agreements = [...signed.values()];
    const errors = requestErrors({ ...toAccount(row), contact, identity: identity!, disclosures, trusted_contact: trusted ?? undefined, agreements }, { storedTaxId: true });
    if (errors.length > 0) throw invalid(errors);
    const review = updateNeedsReview(
        { contact: row.contact as Record<string, unknown>, identity: row.identity as Record<string, unknown>, disclosures: row.disclosures as Record<string, unknown> },
        { contact: update.contact as Record<string, unknown> | undefined, identity: update.identity as Record<string, unknown> | undefined, disclosures: update.disclosures as Record<string, unknown> | undefined }
    );
    const { rows: [updated] } = await pool.query<SimAccountRow>(
        `UPDATE sim_accounts SET contact = $2, identity = $3, disclosures = $4, trusted_contact = $5, agreements = $6,
                status = CASE WHEN $7 THEN 'ACCOUNT_UPDATED' ELSE status END,
                status_due_at = CASE WHEN $7 THEN now() + make_interval(secs => $8) ELSE status_due_at END, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [accountId, JSON.stringify(contact), JSON.stringify(identity), JSON.stringify(disclosures), trusted ? JSON.stringify(trusted) : null,
            JSON.stringify(agreements), review, Number(process.env.SIM_KYC_REVIEW_SECONDS ?? 60)]
    );
    if (review && row.status !== "ACCOUNT_UPDATED") await statusEvent(updated, row.status, "ACCOUNT_UPDATED");
    return toAccount(updated);
};

// POST /v1/accounts/{id}/actions/close. Like Alpaca, the caller must first close the positions and withdraw the cash.
export const closeAccount = async (accountId: string): Promise<void> => {
    const row = await readRow(accountId);
    if (row.status === "ACCOUNT_CLOSED") return;
    await pool.query("UPDATE sim_accounts SET status = 'ACCOUNT_CLOSED', status_due_at = NULL, closed_at = now(), updated_at = now() WHERE id = $1", [accountId]);
    await statusEvent(row, row.status, "ACCOUNT_CLOSED");
};

// POST /v1/accounts/{id}/documents/upload. Only each document's type and a fingerprint are kept, never its content.
export const uploadDocuments = async (accountId: string, documents: OwnerDocumentUploadRequest[]): Promise<void> => {
    const row = await readRow(accountId);
    if (documents.length === 0) throw invalid(["at least one document is required"]);
    const stored = documents.map(document => {
        if (!document.document_type || !document.mime_type || !document.content) throw invalid(["each document needs document_type, mime_type and content"]);
        if (!["application/pdf", "image/png", "image/jpeg"].includes(document.mime_type)) throw invalid([`mime_type ${document.mime_type} isn't accepted`]);
        const content = Buffer.from(document.content, "base64");
        return {
            id: randomUUID(), document_type: document.document_type, document_sub_type: document.document_sub_type, mime_type: document.mime_type,
            created_at: new Date().toISOString(), size: content.length, sha256: createHash("sha256").update(content).digest("hex")
        };
    });
    await pool.query("UPDATE sim_accounts SET documents = documents || $2::jsonb, updated_at = now() WHERE id = $1", [accountId, JSON.stringify(stored)]);
    await advance(await loadRow(row.id));
};

export const getConfigurations = async (accountId: string): Promise<AccountConfigurations> => (await readRow(accountId)).configurations;

// PATCH /v1/trading/accounts/{id}/account/configurations (configurationError's rules)
export const updateConfigurations = async (accountId: string, update: AccountConfigurations): Promise<AccountConfigurations> => {
    const row = await readRow(accountId);
    const error = configurationError(update, { hasMarginAgreement: agreementNames(row.agreements).includes("margin_agreement"), approvedOptionsLevel: row.options_approved_level });
    if (error) throw invalid([error]);
    const configurations = { ...row.configurations, ...update };
    await pool.query("UPDATE sim_accounts SET configurations = $2, updated_at = now() WHERE id = $1", [accountId, JSON.stringify(configurations)]);
    return configurations;
};

// POST /v1/accounts/{id}/options/approval: PENDING, decided a few seconds later (decideOptionsApproval), once the account is active
export const requestOptionsApproval = async (accountId: string, level: number): Promise<OptionsApprovalResponse> => {
    const row = await readRow(accountId);
    if (row.status === "REJECTED" || row.status === "ACCOUNT_CLOSED") throw new BrokerError(422, 42210000, `options can't be requested for an account in status ${row.status}`);
    if (![1, 2, 3].includes(level)) throw invalid(["level must be 1, 2 or 3"]);
    const { rows: [approval] } = await pool.query(
        `INSERT INTO sim_options_approvals (id, account_id, requested_level, due_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING *`,
        [randomUUID(), accountId, level, OPTIONS_REVIEW_SECONDS]
    );
    return toOptionsApproval(approval);
};

// The account's options approval requests, newest first (the app shows the latest)
export const listOptionsApprovals = async (accountId: string): Promise<OptionsApprovalResponse[]> => {
    await readRow(accountId);
    const { rows } = await pool.query("SELECT * FROM sim_options_approvals WHERE account_id = $1 ORDER BY created_at DESC", [accountId]);
    return rows.map(toOptionsApproval);
};
