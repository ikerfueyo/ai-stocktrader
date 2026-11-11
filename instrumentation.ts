// Runs once when the Next.js server starts, in the Node.js runtime: checks what going live with Alpaca needs (lib/server/readiness.ts;
// with Alpaca's production credentials, a problem stops the server), then starts the background job (lib/server/jobs.ts) unless
// BACKGROUND_JOBS=off. The imports stay inside the NEXT_RUNTIME check, so the bundler leaves them (and pg) out of other runtimes.
export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { checkReadiness } = await import("./lib/server/readiness");
        try {
            checkReadiness(process.env);
        } catch (error) {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        }
        if (process.env.BACKGROUND_JOBS !== "off") {
            const { startBackgroundJobs } = await import("./lib/server/jobs");
            startBackgroundJobs();
        }
    }
}
