import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { fetchPrices } from "@/lib/server/alphaVantage";
import { assessWithdrawal, roundCents } from "@/lib/server/account";
import { getAccount, shortTickers, withAccountLock } from "@/lib/server/portfolio";
import type { TransferRequest, TransferRow } from "@/lib/types";

// Create a mock deposit or withdrawal. method is a display label only, such as "Visa •••• 4242".
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as Partial<TransferRequest> | null;
    const { type, method, amount: requestedAmount } = body?.transfer ?? {};
    if (type !== "DEPOSIT" && type !== "WITHDRAW") {
        throw new HttpError("Transfer type must be DEPOSIT or WITHDRAW", 400);
    }
    if (typeof method !== "string" || !method.trim()) {
        throw new HttpError("A payment method is required", 400);
    }
    const amount = roundCents(Number(requestedAmount));
    // The upper limit is what amount's DECIMAL(10, 2) column holds
    if (!(amount > 0 && amount <= 99999999.99)) {
        throw new HttpError("Amount must be between $0.01 and $99,999,999.99", 400);
    }
    const insert = () => pool.query<TransferRow>(
        'INSERT INTO cash_transfers (user_id, "type", method, amount) VALUES($1, $2, $3, $4) RETURNING *',
        [userId, type, method.trim().slice(0, 255), amount]
    );
    // A deposit is always allowed and needs no lock: it can only add cash, such as to meet a margin call before the next buy-in check
    if (type === "DEPOSIT") {
        return NextResponse.json((await insert()).rows[0]);
    }
    // A withdrawal only comes from available cash, never from short collateral
    const newTransfer = await withAccountLock(userId, async () => {
        const { positions, totalCash } = await getAccount(userId);
        const { prices, staleTickers } = await fetchPrices(shortTickers(positions), "POST /api/transfers");
        const assessment = assessWithdrawal({ positions, totalCash, prices, staleTickers, amount });
        if (!assessment.allowed) {
            throw new HttpError(assessment.message, assessment.status);
        }
        return insert();
    });
    return NextResponse.json(newTransfer.rows[0]);
});

// Get all of the user's deposits and withdrawals
export const GET = withUser(async (request, context, userId) => {
    const allTransfers = await pool.query<TransferRow>('SELECT * FROM cash_transfers WHERE user_id = $1 ORDER BY "date" DESC, id DESC', [userId]);
    return NextResponse.json(allTransfers.rows);
});
