import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getPreferences, setPreferences } from "@/lib/server/notifications";
import type { NotificationPreferences } from "@/lib/types";

export const GET = withUser(async (request, context, userId) => NextResponse.json({ preferences: await getPreferences(userId) }));

// Body { preferences: { [kind]: { inApp, browser } } }, any kinds
export const PUT = withUser(async (request, context, userId) => {
    const body = await request.json().catch(() => null) as { preferences?: Partial<NotificationPreferences> } | null;
    if (!body?.preferences || typeof body.preferences !== "object") throw new HttpError("preferences is required", 400);
    return NextResponse.json({ preferences: await setPreferences(userId, body.preferences) });
});
