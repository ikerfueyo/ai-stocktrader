import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { requireSecondFactor } from "@/lib/server/sensitive";
import { cancelRecurring, updateRecurring } from "@/lib/server/automation/recurring";
import type { Frequency } from "@/lib/automation";

interface RecurringContext {
    params: Promise<{ id: string }>;
}

// Body { amount?, frequency?, startDate?, status?: active | paused }
export const PATCH = withUser(async (request, { params }: RecurringContext, userId) => {
    const body = await request.json().catch(() => null) as { amount?: unknown; frequency?: unknown; startDate?: unknown; status?: unknown } | null;
    if (!body) throw new HttpError("A JSON body is required", 400);
    // Resuming it or raising its amount authorizes buys; pausing alone doesn't
    if (!(body.status === "paused" && body.amount === undefined && body.frequency === undefined && body.startDate === undefined)) await requireSecondFactor(userId);
    return NextResponse.json({
        recurring: await updateRecurring(userId, (await params).id, {
            amount: body.amount === undefined ? undefined : Number(body.amount), frequency: body.frequency as Frequency | undefined,
            startDate: body.startDate === undefined ? undefined : String(body.startDate), status: body.status as "active" | "paused" | undefined
        })
    });
});

export const DELETE = withUser(async (request, { params }: RecurringContext, userId) => {
    await cancelRecurring(userId, (await params).id);
    return NextResponse.json({ ok: true });
});
