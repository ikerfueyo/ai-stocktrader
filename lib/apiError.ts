import axios from "axios";
import type { ApiError } from "./types";

// The message to show for a failed API call: the server's { error } when it sent one, otherwise the request's own error
export const apiErrorMessage = (error: unknown): string => {
    if (axios.isAxiosError<ApiError>(error)) return error.response?.data?.error ?? error.message;
    return error instanceof Error ? error.message : String(error);
};

// What the components log for a failed call (the request's own message, as before)
export const logError = (error: unknown) => console.error(error instanceof Error ? error.message : error);
