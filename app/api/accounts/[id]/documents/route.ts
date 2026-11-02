import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { OwnerDocumentUploadRequest } from "@/lib/server/broker/types";
import type { AccountContext } from "../route";

// An uploaded file, base64-encoded, may be at most this big
const MAX_BYTES = 5 * 1024 * 1024;

// Upload documents the review asked for (ACTION_REQUIRED), such as a photo ID: body { documents: [{ document_type,
// document_sub_type, mime_type (PDF, PNG or JPEG), content (base64) }] }. The simulator keeps only each file's type and fingerprint.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as { documents?: OwnerDocumentUploadRequest[] } | null;
    const documents = body?.documents;
    if (!Array.isArray(documents) || documents.length === 0 || documents.length > 4) throw new HttpError("Upload 1 to 4 documents", 400);
    if (documents.some(({ content }) => typeof content !== "string" || content.length * 0.75 > MAX_BYTES)) throw new HttpError("Each document must be at most 5 MB", 400);
    await getBroker().uploadDocuments(account_id, documents);
    return new NextResponse(null, { status: 204 });
});
