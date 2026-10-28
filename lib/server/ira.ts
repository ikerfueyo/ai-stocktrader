import "server-only";
import type { NextRequest } from "next/server";
import pool from "./db";
import { getBroker } from "./broker";
import { HttpError } from "./httpError";
import { clientIp, FINAL_STATUSES, listAccountRows } from "./brokerAccounts";
import {
    beneficiaryErrors, contributionDeadline, contributionError, contributionLimit, contributionTaxYears, DISTRIBUTION_REASONS, distributionReasonsFor, IRA_LABELS, spousalConsentMayBeNeeded,
    type BeneficiaryInput, type IraSubType
} from "../ira";
import { easternParts } from "../marketHours";
import type { AccountCreationRequest, Transfer } from "./broker/types";
import type { BrokerAccount, IraOverview } from "../types";

// The app's side of IRAs (lib/ira.ts has the rules): a user's contributions across their IRAs (the limit is per person, so the app
// checks it before a contribution; the broker only reports excess by age), what the pages show about the active IRA, and opening an
// IRA from the user's individual account, as Alpaca's shared KYC allows: the same reviewed details, the tax ID entered again (it isn't
// kept), the IRA's type and beneficiaries, and the agreements signed again.

const KINDS: Record<IraSubType, "traditional_ira" | "roth_ira"> = { traditional: "traditional_ira", roth: "roth_ira" };
const COUNTED = (status: string) => !["CANCELED", "REJECTED", "RETURNED"].includes(status);

const iraRows = async (userId: string) => (await listAccountRows(userId)).filter(({ kind }) => kind !== "individual");

// What the user has contributed for each tax year across their IRAs: contributions not cancelled, rejected or returned
export const contributionsByYear = async (userId: string): Promise<Map<number, number>> => {
    const totals = new Map<number, number>();
    for (const row of await iraRows(userId)) {
        const transfers = await getBroker().listTransfers(row.account_id) as (Transfer & { ira?: { tax_year?: string } })[];
        for (const transfer of transfers) {
            if (transfer.direction !== "INCOMING" || !COUNTED(transfer.status) || !transfer.ira?.tax_year) continue;
            const year = Number(transfer.ira.tax_year);
            totals.set(year, Math.round(((totals.get(year) ?? 0) + Number(transfer.amount)) * 100) / 100);
        }
    }
    return totals;
};

const dateOfBirthOf = (account: BrokerAccount) => (account.identity as { date_of_birth?: string } | undefined)?.date_of_birth ?? "1900-01-01";

// GET /api/ira: the tax years open for contributions with the user's limit, what's been contributed across their IRAs and what's left,
// and for an IRA account its type, the distribution reasons that fit now, its beneficiaries and whether spousal consent may be needed
export const iraOverview = async (userId: string, accountId: string | null): Promise<IraOverview> => {
    const today = easternParts(new Date()).dateKey;
    const rows = await listAccountRows(userId);
    const row = rows.find(({ account_id }) => account_id === accountId);
    const account = row ? await getBroker().getAccount(row.account_id) as BrokerAccount & { account_sub_type?: IraSubType; beneficiaries?: BeneficiaryInput[] } : null;
    const anyAccount = account ?? (rows[0] ? await getBroker().getAccount(rows[0].account_id) : null);
    const dateOfBirth = anyAccount ? dateOfBirthOf(anyAccount) : "1900-01-01";
    const contributed = await contributionsByYear(userId);
    const years = contributionTaxYears(today).map(taxYear => {
        const limit = contributionLimit(taxYear, dateOfBirth);
        const total = contributed.get(taxYear) ?? 0;
        return { taxYear, limit, contributed: total, remaining: Math.max(0, Math.round((limit - total) * 100) / 100), deadline: contributionDeadline(taxYear) };
    });
    const open = await Promise.all(rows.filter(({ kind }) => kind !== "individual").map(async entry => ({ entry, status: (await getBroker().getAccount(entry.account_id)).status })));
    const openKinds = open.filter(({ status }) => !FINAL_STATUSES.includes(status)).map(({ entry }) => entry.kind);
    if (!account || account.account_type !== "ira") return { years, account: null, openKinds };
    const subType = account.account_sub_type ?? "traditional";
    const firstContributionYear = [...contributed.keys()].length > 0 ? Math.min(...contributed.keys()) : null;
    return {
        years, openKinds,
        account: {
            subType, label: IRA_LABELS[subType],
            distributionReasons: distributionReasonsFor(subType, { dateOfBirth, day: today, firstContributionYear })
                .map(reason => ({ reason, label: DISTRIBUTION_REASONS[reason].label, code: DISTRIBUTION_REASONS[reason].code })),
            beneficiaries: account.beneficiaries ?? [],
            spousalConsentMayBeNeeded: spousalConsentMayBeNeeded(account.contact?.state, account.beneficiaries ?? [])
        }
    };
};

// Why an IRA contribution can't be made, or null: the tax year must be open and the amount within what's left of the user's limit
// across their IRAs
export const contributionProblem = async (userId: string, accountId: string, amount: number, taxYear: number): Promise<string | null> => {
    const account = await getBroker().getAccount(accountId);
    const contributed = (await contributionsByYear(userId)).get(taxYear) ?? 0;
    return contributionError({ amount, taxYear, day: easternParts(new Date()).dateKey, dateOfBirth: dateOfBirthOf(account), contributed });
};

const digits = (value: string) => value.replace(/\D/g, "");

// POST /api/accounts/ira: opens a traditional or Roth IRA for a user with an active individual account, from its reviewed details. The
// tax ID must match the one on file (its last 4 digits are kept). One open IRA of each type.
export const openIra = async (request: NextRequest, userId: string, input: { subType?: unknown; taxId?: unknown; beneficiaries?: unknown; acceptedAgreements?: unknown; iraDisclosure?: unknown }): Promise<BrokerAccount> => {
    const subType = input.subType as IraSubType;
    if (subType !== "traditional" && subType !== "roth") throw new HttpError("Pick a traditional or Roth IRA", 400);
    if (input.iraDisclosure !== true) throw new HttpError("Read and accept the IRA disclosure statement and custodial agreement", 400);
    if (input.acceptedAgreements !== true) throw new HttpError("Accept the customer agreement and the account agreement for the IRA", 400);
    const beneficiaries = (Array.isArray(input.beneficiaries) ? input.beneficiaries : []) as BeneficiaryInput[];
    const problems = beneficiaryErrors(beneficiaries, easternParts(new Date()).dateKey);
    if (problems.length > 0) throw new HttpError(problems.join("; "), 400);
    const broker = getBroker();
    const rows = await listAccountRows(userId);
    const accounts = await Promise.all(rows.map(async row => ({ row, account: await broker.getAccount(row.account_id) })));
    const individual = accounts.find(({ row, account }) => row.kind === "individual" && ["ACTIVE", "ACCOUNT_UPDATED"].includes(account.status));
    if (!individual) throw new HttpError("Open an individual account first: an IRA uses its reviewed details", 409);
    if (accounts.some(({ row, account }) => row.kind === KINDS[subType] && !FINAL_STATUSES.includes(account.status))) throw new HttpError(`You already have a ${IRA_LABELS[subType]}`, 409);
    const taxId = digits(String(input.taxId ?? ""));
    const stored = digits(String(individual.account.identity?.tax_id ?? ""));
    if (taxId.length !== 9 || !stored || taxId.slice(-4) !== stored.slice(-4)) throw new HttpError("Enter the Social Security number on your account (it isn't kept, so it's asked again)", 400);
    const signedAt = new Date().toISOString();
    const ip = clientIp(request);
    const source = individual.account;
    const accountRequest: AccountCreationRequest = {
        account_type: "ira", account_sub_type: subType, allow_instant_ach: false,
        contact: source.contact, disclosures: source.disclosures,
        identity: { ...source.identity!, tax_id: `${taxId.slice(0, 3)}-${taxId.slice(3, 5)}-${taxId.slice(5)}` },
        ...(source.trusted_contact ? { trusted_contact: source.trusted_contact } : {}),
        agreements: (["customer_agreement", "account_agreement"] as const).map(agreement => ({ agreement: agreement as never, signed_at: signedAt, ip_address: ip })),
        beneficiaries: beneficiaries.map(beneficiary => ({ ...beneficiary, tax_id: `${digits(beneficiary.tax_id).slice(0, 3)}-${digits(beneficiary.tax_id).slice(3, 5)}-${digits(beneficiary.tax_id).slice(5)}`, tax_id_type: "USA_SSN" })),
        enabled_assets: ["us_equity"]
    } as AccountCreationRequest;
    const account = await broker.createAccount(accountRequest);
    await pool.query("INSERT INTO broker_accounts (account_id, user_id, broker, kind, account_number) VALUES ($1, $2, 'sim', $3, $4)", [account.id, userId, KINDS[subType], account.account_number]);
    await pool.query(
        `INSERT INTO account_attestations (account_id, kind, details, ip_address) VALUES ($1, 'ira_disclosure', $2, $3), ($1, 'form_crs', '{}', $3), ($1, 'privacy_notice', '{}', $3)`,
        [account.id, JSON.stringify({ sub_type: subType }), ip]
    );
    return account;
};
