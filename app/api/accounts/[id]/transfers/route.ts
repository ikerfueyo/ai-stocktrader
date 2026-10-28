import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount, requireAccount } from "@/lib/server/brokerAccounts";
import { withAccountLock } from "@/lib/server/portfolio";
import { marginSnapshot, withdrawalError } from "@/lib/server/broker/sim/marginAccount";
import pool from "@/lib/server/db";
import { TRANSFER_FEES } from "@/lib/server/broker/sim/funding";
import type { CreateTransferRequest } from "@/lib/server/broker/types";
import type { BrokerTransfer, TransferRequest } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's transfers, newest first, with their status (QUEUED, SENT_TO_CLEARING, COMPLETE, CANCELED, RETURNED, ...) and
// expires_at, when the money is expected
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<BrokerTransfer[]>(await getBroker().listTransfers(account_id));
});

// Request a transfer: body { transfer: { type: ach | wire, direction: INCOMING | OUTGOING, amount, relationshipId | bankId } }.
// Deposits are ACH from the approved bank link; withdrawals go by ACH to it or by wire (with its fee) to a recipient bank. A
// withdrawal can only come from withdrawable cash (the broker's margin account: settled cash, less deposit credit and sale proceeds
// not yet settled and another queued withdrawal, no more than the excess over Reg T initial margin less what open orders hold), and
// not during a margin call. The broker sets the timing, limits and fees.
export const POST = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as Partial<TransferRequest> | null;
    const { type, direction, amount: requested, relationshipId, bankId } = body?.transfer ?? {};
    if (type !== "ach" && type !== "wire") throw new HttpError("type must be ach or wire", 400);
    if (direction !== "INCOMING" && direction !== "OUTGOING") throw new HttpError("direction must be INCOMING or OUTGOING", 400);
    const amount = Number(requested);
    if (!(amount > 0) || Math.round(amount * 100) !== amount * 100) throw new HttpError("amount must be a positive dollar amount", 400);
    const { accountId } = await requireAccount(request, userId, direction === "INCOMING" ? "deposit" : "withdraw");
    if (accountId !== account_id) throw new HttpError("Switch to this account to move money in or out of it", 409);
    const transfer: CreateTransferRequest = {
        transfer_type: type, direction, amount: amount.toFixed(2),
        ...(type === "ach" ? { relationship_id: String(relationshipId ?? "") } : { bank_id: String(bankId ?? "") })
    };
    if (direction === "INCOMING") {
        return NextResponse.json<BrokerTransfer>(await getBroker().createTransfer(account_id, transfer), { status: 201 });
    }
    const fee = type === "wire" ? TRANSFER_FEES.wireOutDomestic : 0;
    const created = await withAccountLock(userId, async () => {
        const snapshot = await marginSnapshot(pool, account_id);
        const problem = withdrawalError(snapshot, amount + fee);
        if (problem) {
            // Neither instant deposit credit nor sale proceeds can leave before they settle
            const { unsettledInstant, unsettledProceeds } = snapshot.ledger;
            const unsettled = [
                unsettledInstant > 0 ? `$${unsettledInstant.toFixed(2)} of instant deposit credit` : null,
                unsettledProceeds > 0 ? `$${unsettledProceeds.toFixed(2)} of sale proceeds` : null
            ].filter(Boolean);
            const note = unsettled.length > 0 && problem.status === 400 && snapshot.calls.length === 0 ? ` (${unsettled.join(" and ")} can't be withdrawn until settled)` : "";
            throw new HttpError(`${problem.message}${fee > 0 ? `, including the $${fee} wire fee` : ""}${note}`, problem.status);
        }
        return getBroker().createTransfer(account_id, transfer);
    });
    return NextResponse.json<BrokerTransfer>(created, { status: 201 });
});
