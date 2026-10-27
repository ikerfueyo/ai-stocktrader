import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";

interface RelationshipContext {
    params: Promise<{ id: string; relationshipId: string }>;
}

// Remove a bank link (422 while it has transfers in progress)
export const DELETE = withUser(async (request, { params }: RelationshipContext, userId) => {
    const { id, relationshipId } = await params;
    const { account_id } = await findUserAccount(userId, id);
    await getBroker().deleteAchRelationship(account_id, relationshipId);
    return new NextResponse(null, { status: 204 });
});
