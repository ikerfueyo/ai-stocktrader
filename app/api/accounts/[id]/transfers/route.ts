import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount, requireAccount } from "@/lib/server/brokerAccounts";
import { fetchPrices } from "@/lib/server/marketData";
import { assessWithdrawal } from "@/lib/server/account";
import { getAccount, shortTickers, withAccountLock } from "@/lib/server/portfolio";
import { getOpenOrders, reservedCashFor } from "@/lib/server/orders";
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
// withdrawal can only come from withdrawable cash: available cash (never short collateral, cash reserved for orders or another
// queued withdrawal) less deposit credit not yet settled, and not during a margin call. The broker sets the timing, limits and
// fees. Until the simulator keeps the whole ledger (Phase 3), the check runs on the mock ledger.
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
    const created = await withAccountLock(userId, async db => {
        const { positions, totalCash, unsettledInstant } = await getAccount(userId, db);
        const label = `POST /api/accounts/${account_id}/transfers`;
        const { prices, staleTickers } = await fetchPrices(shortTickers(positions), label);
        const reservedCash = await reservedCashFor(await getOpenOrders(userId, db), positions, label);
        const assessment = assessWithdrawal({ positions, totalCash: totalCash - unsettledInstant, prices, staleTickers, amount: amount + fee, reservedCash });
        if (!assessment.allowed) {
            const note = unsettledInstant > 0 ? ` ($${unsettledInstant.toFixed(2)} of instant deposit credit can't be withdrawn until it settles)` : "";
            throw new HttpError(`${assessment.message}${fee > 0 ? `, including the $${fee} wire fee` : ""}${note}`, assessment.status);
        }
        return getBroker().createTransfer(account_id, transfer);
    });
    return NextResponse.json<BrokerTransfer>(created, { status: 201 });
});
