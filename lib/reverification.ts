// Clerk's reverification hint, the body a route answers (403) when the session must verify again (lib/server/sensitive.ts). The same
// check as Clerk's own isReverificationHint, which @clerk/nextjs doesn't export.
export const isReverificationHint = (value: unknown): value is { clerk_error: { type: "forbidden"; reason: "reverification-error" } } => {
    const error = (value as { clerk_error?: { type?: unknown; reason?: unknown } } | null)?.clerk_error;
    return typeof value === "object" && value !== null && error?.type === "forbidden" && error.reason === "reverification-error";
};
