import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import OpenAI from "openai";
import type { ApiError } from "../types";

import { HttpError, UpstreamError, isHttpError } from "./httpError";
import { ACCOUNT_HEADER, ACTIVE_ACCOUNT_COOKIE, withRequestContext } from "./requestContext";

export { HttpError, UpstreamError };

// The fields of the errors thrown here: pg, axios and Node errors carry a code, and AggregateError the errors it wraps
interface ErrorLike {
    message?: string;
    code?: string;
    errors?: { message: string }[];
}

// Logs METHOD path: message and returns { error: message } (with an HttpError's details, such as a reverification hint) with the
// status the error contract gives it
export const errorResponse = (request: NextRequest, error: unknown): NextResponse<ApiError> => {
    const { message: errorMessage, code, errors } = (error ?? {}) as ErrorLike;
    // pg throws an AggregateError with an empty message when every address for the host fails (e.g. ::1 and 127.0.0.1)
    const message = errorMessage || errors?.map(e => e.message).join("; ") || code || "Unknown error";
    console.error(`${request.method} ${request.nextUrl.pathname}${request.nextUrl.search}: ${message}`);
    let status = 500;
    let details: Record<string, unknown> = {};
    if (isHttpError(error)) {
        status = error.status;
        details = error.details ?? {};
    } else if (code === "ECONNABORTED" || code === "ETIMEDOUT" || error instanceof OpenAI.APIConnectionTimeoutError) {
        status = 504;
    } else if (error instanceof OpenAI.APIError) {
        status = 502;
    }
    return NextResponse.json({ ...details, error: message }, { status });
};

// Every API route needs a signed-in Clerk user (proxy.ts reads the session), so anonymous callers can't read accounts or spend
// the Alpha Vantage and OpenAI quota. The handler gets the user ID, which scopes every account query. Errors it throws become
// error responses.
export const withUser = <Context>(handler: (request: NextRequest, context: Context, userId: string) => Promise<Response>) =>
    async (request: NextRequest, context: Context): Promise<Response> => {
        try {
            const { userId } = await auth();
            if (!userId) {
                throw new HttpError("Sign in required", 401);
            }
            // The account the request is for: the one its page shows, else the one the account switcher made active (ledgerAccountId
            // and requireAccount check it's the user's and open)
            const shown = request.headers.get(ACCOUNT_HEADER)?.trim() || null;
            return await withRequestContext({ activeAccountId: shown ?? request.cookies.get(ACTIVE_ACCOUNT_COOKIE)?.value ?? null, pinned: shown !== null }, () => handler(request, context, userId));
        } catch (error) {
            return errorResponse(request, error);
        }
    };

// The context of a route with a [ticker] segment
export interface TickerContext {
    params: Promise<{ ticker: string }>;
}
