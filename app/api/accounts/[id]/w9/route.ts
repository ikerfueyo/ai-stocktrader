import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { clientIp, findUserAccount } from "@/lib/server/brokerAccounts";
import type { W9Certification } from "@/lib/types";
import type { AccountContext } from "../route";

const latest = async (accountId: string): Promise<W9Certification> => {
    const { rows: [row] } = await pool.query<{ details: { backup_withholding?: boolean }; signed_at: Date }>(
        "SELECT details, signed_at FROM account_attestations WHERE account_id = $1 AND kind = 'w9' ORDER BY signed_at DESC, id DESC LIMIT 1", [accountId]
    );
    return row
        ? { onFile: true, backupWithholding: row.details?.backup_withholding === true, signedAt: row.signed_at.toISOString() }
        : { onFile: false, backupWithholding: true, signedAt: null };
};

// The account's W-9 certification: whether one is on file and whether it says the account is subject to backup withholding (24% of
// dividends and sale proceeds withheld while it is, or while none is on file)
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<W9Certification>(await latest(account_id));
});

// Certify again (body { backupWithholding, certify: true }), as after the IRS notifies that backup withholding no longer applies; kept
// with the time and IP like the one signed at onboarding
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as { backupWithholding?: unknown; certify?: unknown } | null;
    if (typeof body?.backupWithholding !== "boolean") throw new HttpError("backupWithholding must be true or false", 400);
    if (body.certify !== true) throw new HttpError("The W-9 certification must be accepted (certify: true)", 400);
    await pool.query(
        "INSERT INTO account_attestations (account_id, kind, details, ip_address) VALUES ($1, 'w9', $2, $3)",
        [account_id, JSON.stringify({ backup_withholding: body.backupWithholding }), clientIp(request)]
    );
    return NextResponse.json<W9Certification>(await latest(account_id), { status: 201 });
});
