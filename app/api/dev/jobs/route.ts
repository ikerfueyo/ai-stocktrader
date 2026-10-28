import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { brokerJobs, runJob } from "@/lib/server/jobs";

// Development only: run a background job now, body { job } (accounts, assets, calendar, sim-accounts, sim-transfers or
// settle-transfers, which moves every in-progress transfer a step; the simulator's jobs only with BROKER=sim), so scheduled work can be tested without
// waiting for its time. 404 in production. Any signed-in user can call it, since there's nothing to protect locally.
export const POST = withUser(async (request) => {
    if (process.env.NODE_ENV === "production") throw new HttpError("Not found", 404);
    const body = await request.json().catch(() => null) as { job?: unknown } | null;
    const jobs = brokerJobs();
    const job = jobs.find(({ name }) => name === body?.job);
    if (!job) throw new HttpError(`job must be one of ${jobs.map(({ name }) => name).join(", ")}`, 400);
    const ran = await runJob(job);
    return NextResponse.json({ job: job.name, ran, ...(ran ? {} : { reason: "already running" }) });
});
