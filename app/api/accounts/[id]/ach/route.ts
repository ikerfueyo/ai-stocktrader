import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { getPlaid } from "@/lib/server/broker/alpaca";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { CreateACHRelationshipRequest } from "@/lib/server/broker/types";
import type { AchRelationship } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's bank links (ACH relationships), newest first, without removed ones. Account numbers are masked.
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<AchRelationship[]>(await getBroker().listAchRelationships(account_id));
});

// Link a bank account: body Alpaca's CreateACHRelationshipRequest (account_owner_name, which must be the account holder,
// bank_account_type CHECKING or SAVINGS, bank_account_number, bank_routing_number, nickname), or { plaid: { public_token, account_id } }
// from Plaid Link, which the server turns into an Alpaca processor token (400 when Plaid isn't configured). It's QUEUED, then APPROVED
// or REJECTED. 409 while another link is queued or approved.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as (CreateACHRelationshipRequest & { plaid?: { public_token?: unknown; account_id?: unknown } }) | null;
    if (!body || typeof body !== "object") throw new HttpError("A bank account is required", 400);
    if (body.plaid) {
        const plaid = getPlaid();
        if (!plaid) throw new HttpError("Plaid isn't set up: enter the routing and account numbers instead", 400);
        const processor_token = await plaid.processorTokenFor(String(body.plaid.public_token ?? ""), String(body.plaid.account_id ?? ""));
        return NextResponse.json<AchRelationship>(await getBroker().createAchRelationship(account_id, { processor_token } as CreateACHRelationshipRequest), { status: 201 });
    }
    const { account_owner_name, bank_account_type, bank_account_number, bank_routing_number, nickname } = body;
    return NextResponse.json<AchRelationship>(
        await getBroker().createAchRelationship(account_id, { account_owner_name, bank_account_type, bank_account_number, bank_routing_number, nickname }),
        { status: 201 }
    );
});
