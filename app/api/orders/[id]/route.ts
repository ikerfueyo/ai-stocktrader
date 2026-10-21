import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { withAccountLock } from "@/lib/server/portfolio";
import type { OrderRow } from "@/lib/types";

interface OrderContext {
    params: Promise<{ id: string }>;
}

// Cancel one of the user's open orders. 404 if it isn't theirs; 409 if it's no longer open (filled, expired or already cancelled).
export const DELETE = withUser(async (request, { params }: OrderContext, userId) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id)) throw new HttpError("Order not found", 404);
    const order = await withAccountLock(userId, async db => {
        const { rows: [existing] } = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1 AND user_id = $2", [id, userId]);
        if (!existing) throw new HttpError("Order not found", 404);
        if (existing.status !== "OPEN") throw new HttpError(`The order is already ${existing.status.toLowerCase()}`, 409);
        const { rows: [cancelled] } = await db.query<OrderRow>(
            `UPDATE orders SET status = 'CANCELLED', status_reason = 'Cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [id]
        );
        return cancelled;
    });
    return NextResponse.json<{ order: OrderRow }>({ order });
});
