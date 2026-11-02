import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { clientIp, findUserAccount } from "@/lib/server/brokerAccounts";
import type { AccountUpdateRequest } from "@/lib/server/broker/types";
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

// Update the account's details: body Alpaca's AccountUpdateRequest with contact, identity (not the tax ID or date of birth),
// disclosures, trusted_contact and agreements (new ones are signed now from this IP). A changed address, name, citizenship or
// employer, or a disclosure turning true, puts the account under review (ACCOUNT_UPDATED, no withdrawals until it passes).
export const PATCH = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as AccountUpdateRequest | null;
    if (!body || typeof body !== "object") throw new HttpError("An update is required", 400);
    const unknown = Object.keys(body).filter(key => !(EDITABLE as readonly string[]).includes(key));
    if (unknown.length > 0) throw new HttpError(`These can't be changed: ${unknown.join(", ")}`, 400);
    const signedAt = new Date().toISOString();
    const update: AccountUpdateRequest = {
        ...body,
        ...(body.agreements ? { agreements: body.agreements.map(({ agreement }) => ({ agreement, signed_at: signedAt, ip_address: clientIp(request) })) } : {})
    };
    return NextResponse.json<BrokerAccount>(await getBroker().updateAccount(account_id, update));
});
