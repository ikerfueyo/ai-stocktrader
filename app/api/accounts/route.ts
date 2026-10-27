import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { clientIp, FINAL_STATUSES, listAccountRows, listAccounts } from "@/lib/server/brokerAccounts";
import { validateApplication } from "@/lib/kyc";
import { easternParts } from "@/lib/marketHours";
import type { AccountCreationRequest } from "@/lib/server/broker/types";
import type { BrokerAccount, BrokerAccountSummary, OpenAccountRequest } from "@/lib/types";

// Get the user's brokerage accounts with their status, newest first, and which one is active
export const GET = withUser(async (request, context, userId) => NextResponse.json<BrokerAccountSummary[]>(await listAccounts(request, userId)));

const digits = (value: string) => value.replace(/\D/g, "");
const optional = <T extends Record<string, unknown>>(object: T) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== "")) as T;

// Apply for an individual account: body { application } (lib/kyc.ts's AccountApplication, checked with validateApplication; 400
// listing the problems). The server signs each accepted agreement with the time and the client's IP, sends Alpaca's account request
// to the broker (which reviews it: SUBMITTED, then usually ACTIVE within seconds), records the W-9 certification and the delivered
// disclosures, and asks for options approval when the options agreement was accepted. 409 while the user has an account that isn't
// rejected or closed.
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<OpenAccountRequest> | null;
    const application = body?.application;
    if (!application?.contact || !application.identity || !application.disclosures || !Array.isArray(application.agreements)) {
        throw new HttpError("An application with contact, identity, disclosures and agreements is required", 400);
    }
    const errors = validateApplication(application, easternParts(new Date()).dateKey);
    if (Object.keys(errors).length > 0) throw new HttpError(Object.values(errors).join("; "), 400);

    const broker = getBroker();
    const existing = await Promise.all((await listAccountRows(userId)).filter(({ kind }) => kind === "individual").map(row => broker.getAccount(row.account_id)));
    if (existing.some(({ status }) => !FINAL_STATUSES.includes(status))) {
        throw new HttpError("You already have an individual account", 409);
    }

    const signedAt = new Date().toISOString();
    const ip = clientIp(request);
    const { contact, identity, disclosures, trusted_contact: trusted } = application;
    const phone = digits(contact.phone_number).slice(-10);
    const taxId = digits(identity.tax_id);
    const options = application.agreements.includes("options_agreement");
    const accountRequest: AccountCreationRequest = {
        account_type: "trading",
        allow_instant_ach: false,
        contact: optional({
            email_address: contact.email_address.trim(), phone_number: `+1${phone}`, street_address: contact.street_address.map(line => line.trim()).filter(Boolean),
            unit: contact.unit?.trim(), city: contact.city.trim(), state: contact.state, postal_code: contact.postal_code.trim(), country: "USA"
        }),
        identity: optional({
            ...identity,
            given_name: identity.given_name.trim(), middle_name: identity.middle_name?.trim(), family_name: identity.family_name.trim(),
            tax_id: `${taxId.slice(0, 3)}-${taxId.slice(3, 5)}-${taxId.slice(5)}`
        }),
        disclosures: optional({ ...disclosures, context: disclosures.context?.length ? disclosures.context : undefined }),
        ...(trusted?.given_name ? { trusted_contact: optional({ ...trusted }) } : {}),
        agreements: application.agreements.map(agreement => ({ agreement, signed_at: signedAt, ip_address: ip })),
        enabled_assets: options ? ["us_equity", "us_option"] : ["us_equity"]
    };
    const account: BrokerAccount = await broker.createAccount(accountRequest);
    await pool.query(
        "INSERT INTO broker_accounts (account_id, user_id, broker, kind, account_number) VALUES ($1, $2, 'sim', 'individual', $3)",
        [account.id, userId, account.account_number]
    );
    await pool.query(
        `INSERT INTO account_attestations (account_id, kind, details, ip_address) VALUES ($1, 'w9', $2, $3), ($1, 'form_crs', '{}', $3), ($1, 'privacy_notice', '{}', $3)`,
        [account.id, JSON.stringify({ backup_withholding: application.w9.backup_withholding }), ip]
    );
    if (options && application.options_level) await broker.requestOptionsApproval(account.id, { level: application.options_level as 1 | 2 | 3 });
    return NextResponse.json<BrokerAccount>(account, { status: 201 });
});
