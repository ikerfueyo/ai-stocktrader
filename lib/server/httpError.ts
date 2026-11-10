// Errors reported to the client with a status, such as 400 for a bad request. Kept out of errors.ts (server-only, and it loads Clerk
// for withUser), so pure and library modules can throw them without depending on the request layer, and can be unit tested.
export class HttpError extends Error {
    status: number;
    // Marks the error as one of these, so it's recognized even when a dev hot reload has loaded this module twice and instanceof
    // compares against the other copy of the class (which turned the broker's 4xx refusals into 500s)
    readonly isHttpError = true;
    // More fields for the response body beside { error }, such as Clerk's reverification hint
    details?: Record<string, unknown>;

    constructor(message: string, status: number, details?: Record<string, unknown>) {
        super(message);
        this.status = status;
        if (details) this.details = details;
    }
}

// Error from a third-party API, reported to the client as 502
export class UpstreamError extends HttpError {
    constructor(message: string, status = 502) {
        super(message, status);
    }
}

export const isHttpError = (error: unknown): error is HttpError =>
    error instanceof HttpError || (error instanceof Error && (error as { isHttpError?: unknown }).isHttpError === true && typeof (error as { status?: unknown }).status === "number");
