import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import OpenAI from "openai";
import type { ApiError } from "../types";

import { HttpError, isHttpError } from "./httpError";

export { HttpError };

// Error from a third-party API, reported to the client as 502
export class UpstreamError extends HttpError {
    constructor(message: string, status = 502) {
        super(message, status);
    }
}

// The fields of the errors thrown here: pg, axios and Node errors carry a code, and AggregateError the errors it wraps
interface ErrorLike {
    message?: string;
    code?: string;
    errors?: { message: string }[];
}

// Logs METHOD path: message and returns { error: message } with the status the error contract gives it
export const errorResponse = (request: NextRequest, error: unknown): NextResponse<ApiError> => {
    const { message: errorMessage, code, errors } = (error ?? {}) as ErrorLike;
    // pg throws an AggregateError with an empty message when every address for the host fails (e.g. ::1 and 127.0.0.1)
    const message = errorMessage || errors?.map(e => e.message).join("; ") || code || "Unknown error";
    console.error(`${request.method} ${request.nextUrl.pathname}${request.nextUrl.search}: ${message}`);
    let status = 500;
    if (isHttpError(error)) {
        status = error.status;
    } else if (code === "ECONNABORTED" || code === "ETIMEDOUT" || error instanceof OpenAI.APIConnectionTimeoutError) {
        status = 504;
    } else if (error instanceof OpenAI.APIError) {
        status = 502;
    }
    return NextResponse.json({ error: message }, { status });
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
            return await handler(request, context, userId);
        } catch (error) {
            return errorResponse(request, error);
        }
    };

// The context of a route with a [ticker] segment
export interface TickerContext {
    params: Promise<{ ticker: string }>;
}
