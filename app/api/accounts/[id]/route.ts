import { NextResponse } from "next/server";
import { requireRecentSignIn } from "@/lib/server/sensitive";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { clientIp, findUserAccount } from "@/lib/server/brokerAccounts";
import type { AccountUpdateRequest } from "@/lib/server/broker/types";
import { AGREEMENTS } from "@/lib/kyc";
import { brokerRevision, requireCurrentRevisions } from "@/lib/server/agreements";
import type { BrokerAccount } from "@/lib/types";

export interface AccountContext {
    params: Promise<{ id: string }>;
}

// Get one of the user's accounts as the broker has it (Alpaca's Account, with KYC results and trading configurations; the tax ID
// is masked). Reading it advances a review that's due.
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<BrokerAccount>(await getBroker().getAccount(account_id));
});

const EDITABLE = ["contact", "identity", "disclosures", "trusted_contact", "agreements", "beneficiaries"] as const;

// Update the account's details: body Alpaca's AccountUpdateRequest with contact, identity (not the tax ID or date of birth, refused
// here so an SSN never goes to the broker this way), disclosures, trusted_contact and agreements (only the app's: new ones are signed
// now from this IP, at the revision the page showed, `revisions`, 409 if it has changed). Needs a recent sign-in. A changed address, name, citizenship or
// employer, or a disclosure turning true, puts the account under review (ACCOUNT_UPDATED, no withdrawals until it passes).
export const PATCH = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    await requireRecentSignIn(userId);
    const parsed = await request.json().catch(() => null) as (AccountUpdateRequest & { revisions?: unknown }) | null;
    if (!parsed || typeof parsed !== "object") throw new HttpError("An update is required", 400);
    const { revisions, ...body } = parsed;
    const unknown = Object.keys(body).filter(key => !(EDITABLE as readonly string[]).includes(key));
    if (unknown.length > 0) throw new HttpError(`These can't be changed: ${unknown.join(", ")}`, 400);
    const fixed = ["tax_id", "tax_id_type", "date_of_birth"].filter(key => body.identity && key in body.identity);
    if (fixed.length > 0) throw new HttpError(`These can't be changed: ${fixed.map(key => `identity.${key}`).join(", ")}`, 400);
    if (body.agreements && (!Array.isArray(body.agreements) || body.agreements.some(({ agreement }) => !(AGREEMENTS as readonly string[]).includes(agreement)))) {
        throw new HttpError(`Only these agreements can be signed: ${AGREEMENTS.join(", ")}`, 400);
    }
    const signing = (body.agreements ?? []).map(({ agreement }) => agreement as typeof AGREEMENTS[number]);
    if (signing.length > 0) requireCurrentRevisions(signing, revisions);
    const signedAt = new Date().toISOString();
    const update: AccountUpdateRequest = {
        ...body,
        ...(body.agreements ? { agreements: signing.map(agreement => ({ agreement, signed_at: signedAt, ip_address: clientIp(request), ...brokerRevision(agreement) })) } : {})
    };
    return NextResponse.json<BrokerAccount>(await getBroker().updateAccount(account_id, update));
});
