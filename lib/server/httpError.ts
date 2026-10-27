// Error reported to the client with the given status, such as 400 for a bad request. Kept out of errors.ts (server-only), so
// pure modules that throw it can be unit tested.
export class HttpError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}
