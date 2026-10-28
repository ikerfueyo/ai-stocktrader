import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { cancelAlert } from "@/lib/server/automation/alerts";

interface AlertContext {
    params: Promise<{ id: string }>;
}

// Deletes one of the user's alerts (404 when it isn't theirs)
export const DELETE = withUser(async (request, { params }: AlertContext, userId) => {
    await cancelAlert(userId, (await params).id);
    return NextResponse.json({ ok: true });
});
