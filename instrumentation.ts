// Runs once when the Next.js server starts: starts the background job (lib/server/jobs.ts) in the Node.js runtime, unless
// BACKGROUND_JOBS=off
export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs" && process.env.BACKGROUND_JOBS !== "off") {
        const { startBackgroundJobs } = await import("./lib/server/jobs");
        startBackgroundJobs();
    }
}
