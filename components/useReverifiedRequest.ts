"use client";

import { useCallback } from "react";
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { isReverificationHint } from "@/lib/reverification";

// An axios request for the routes that need a recent sign-in (lib/server/sensitive.ts): when the route answers with Clerk's
// reverification hint, Clerk's modal asks the user to verify again and the request is retried. Cancelling the modal rejects with a
// plain message, so apiErrorMessage shows it like any refusal.
export const useReverifiedRequest = () => {
    const run = useReverification(async (config: AxiosRequestConfig) => {
        try {
            return await axios.request(config);
        } catch (error) {
            // Resolving to the hint is what makes the hook open its modal (a rejection is passed through)
            const data = axios.isAxiosError(error) ? error.response?.data : null;
            if (isReverificationHint(data)) return data;
            throw error;
        }
    });
    return useCallback(async <T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
        try {
            return await run(config) as AxiosResponse<T>;
        } catch (error) {
            if (isReverificationCancelledError(error)) throw new Error("Cancelled: confirm it's you to continue");
            throw error;
        }
    }, [run]);
};
