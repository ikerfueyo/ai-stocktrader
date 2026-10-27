// Error reported to the client with the given status, such as 400 for a bad request. Kept out of errors.ts (server-only), so
// pure modules that throw it can be unit tested.
export class HttpError extends Error {
    status: number;
    // Marks the error as one of these, so it's recognized even when a dev hot reload has loaded this module twice and instanceof
    // compares against the other copy of the class (which turned the broker's 4xx refusals into 500s)
    readonly isHttpError = true;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export const isHttpError = (error: unknown): error is HttpError =>
    error instanceof HttpError || (error instanceof Error && (error as { isHttpError?: unknown }).isHttpError === true && typeof (error as { status?: unknown }).status === "number");
