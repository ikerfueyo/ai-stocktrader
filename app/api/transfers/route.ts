import { NextResponse } from "next/server";
import pool from "@/lib/server/db";
import { HttpError, withUser } from "@/lib/server/errors";
import { fetchPrices } from "@/lib/server/alphaVantage";
import { assessWithdrawal, roundCents } from "@/lib/server/account";
import { CASH_ACTIVITY_COLUMNS, getAccount, shortTickers, withAccountLock, type Db } from "@/lib/server/portfolio";
import { getOpenOrders, reservedCashFor } from "@/lib/server/orders";
import type { CashActivityRow, TransferRequest } from "@/lib/types";

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
    // The upper limit is what amount held as DECIMAL(10, 2); the column is DECIMAL(14, 2) now, so it's a sanity limit
    if (!(amount > 0 && amount <= 99999999.99)) {
        throw new HttpError("Amount must be between $0.01 and $99,999,999.99", 400);
    }
    const insert = (db: Db = pool) => db.query<CashActivityRow>(
        `INSERT INTO cash_activity (user_id, "type", method, amount) VALUES($1, $2, $3, $4) RETURNING ${CASH_ACTIVITY_COLUMNS}`,
        [userId, type, method.trim().slice(0, 255), amount]
    );
    // A deposit is always allowed and needs no lock: it can only add cash, such as to meet a margin call before the next buy-in check
    if (type === "DEPOSIT") {
        return NextResponse.json((await insert()).rows[0]);
    }
    // A withdrawal only comes from available cash, never from short collateral or cash reserved for open orders
    const newTransfer = await withAccountLock(userId, async db => {
        const { positions, totalCash } = await getAccount(userId, db);
        const { prices, staleTickers } = await fetchPrices(shortTickers(positions), "POST /api/transfers");
        const reservedCash = await reservedCashFor(await getOpenOrders(userId, db), positions, "POST /api/transfers");
        const assessment = assessWithdrawal({ positions, totalCash, prices, staleTickers, amount, reservedCash });
        if (!assessment.allowed) {
            throw new HttpError(assessment.message, assessment.status);
        }
        return insert(db);
    });
    return NextResponse.json(newTransfer.rows[0]);
});

// Get all of the user's cash activity, newest first: deposits, withdrawals and dividends
export const GET = withUser(async (request, context, userId) => {
    const allTransfers = await pool.query<CashActivityRow>(`SELECT ${CASH_ACTIVITY_COLUMNS} FROM cash_activity WHERE user_id = $1 ORDER BY "date" DESC, id DESC`, [userId]);
    return NextResponse.json(allTransfers.rows);
});
