import { NextResponse } from "next/server";
import pool from "@/lib/server/db";

// The load balancer's health check: no signed-in user needed (no withUser), 503 when the database can't be reached
export const dynamic = "force-dynamic";

export async function GET() {
    try {
        await pool.query("SELECT 1");
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("GET /api/health:", error instanceof Error ? error.message : error);
        return NextResponse.json({ ok: false }, { status: 503 });
    }
}
