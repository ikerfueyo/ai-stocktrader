import { HttpError } from "../httpError";
import type { BrokerErrorBody } from "./types";

// A request the broker rejected, in Alpaca's error shape: an HTTP status (403 for insufficient buying power or a blocked
// account, 404 for something that doesn't exist, 422 for an invalid request) and a numeric code with a message, such as
// 40310000 "insufficient buying power" or 42210000 "invalid limit_price". It extends HttpError, so errorResponse answers with
// the same status and message.
export class BrokerError extends HttpError {
    readonly code: number;
    constructor(status: number, code: number, message: string) {
        super(message, status);
        this.name = "BrokerError";
        this.code = code;
    }

    toBody(): BrokerErrorBody {
        return { code: this.code, message: this.message };
    }
}
