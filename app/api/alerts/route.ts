import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { createAlert, listAlerts } from "@/lib/server/automation/alerts";
import type { AlertCondition } from "@/lib/automation";

// The user's price alerts (active first, then triggered), optionally for one ?symbol=
export const GET = withUser(async (request, context, userId) =>
    NextResponse.json({ alerts: await listAlerts(userId, request.nextUrl.searchParams.get("symbol") ?? undefined) }));

// Body { alert: { symbol, condition: above | below | change_up | change_down, threshold, rearm? } }; 201
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { alert?: { symbol?: unknown; condition?: unknown; threshold?: unknown; rearm?: unknown } } | null;
    const alert = body?.alert;
    if (typeof alert?.symbol !== "string" || !alert.symbol.trim()) throw new HttpError("alert.symbol is required", 400);
    return NextResponse.json({
        alert: await createAlert(userId, { symbol: alert.symbol.trim(), condition: alert.condition as AlertCondition, threshold: Number(alert.threshold), rearm: alert.rearm === true })
    }, { status: 201 });
});
