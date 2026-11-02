import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getPreferences, listNotifications } from "@/lib/server/notifications";
import type { NotificationsResponse } from "@/lib/types";

// The user's notifications, newest first (?limit=, default 50), how many are unread, and their preferences (which kinds the pages
// show as browser notifications)
export const GET = withUser(async (request, context, userId) => {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50) || 50;
    const [{ items, unread }, preferences] = await Promise.all([listNotifications(userId, limit), getPreferences(userId)]);
    return NextResponse.json({ items, unread, preferences } satisfies NotificationsResponse);
});
