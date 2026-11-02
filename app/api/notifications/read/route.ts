import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { markRead } from "@/lib/server/notifications";

// Marks notifications read: body { ids } for some, or {} for all of them
export const POST = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => ({})) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isSafeInteger) : undefined;
    await markRead(userId, ids);
    return NextResponse.json({ ok: true });
});
