"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import axios from "axios";
import { useAuth } from "@clerk/nextjs";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { Account } from "@/lib/types";

interface AccountContextValue {
    account: Account | null;
    error: string | null;
    refreshAccount: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({ account: null, error: null, refreshAccount: async () => {} });

// How often the account is reloaded while the page is visible, so fills, expiries and buy-ins made by the background job show up
const POLL_MS = 60000;

// What changes when an order fills, expires or is cancelled, or a buy-in runs: the positions and the cash held for open orders.
// Lists that are expensive to reload (positions, open orders) reload when it changes.
export const accountActivityKey = (account: Account | null): string =>
    account ? `${account.positions.map(({ ticker, quantity }) => `${ticker}:${quantity}`).join(",")}|${account.reservedCash}` : "";

// Loads /api/account for the whole app once per signed-in user, then every minute while the page is visible and whenever it
// becomes visible again, so the header keeps its figures across pages. Trades and transfers call refreshAccount afterwards. AppShell keys it by user ID, so another user (or none) never sees the
// previous user's figures, or a response still on its way for them.
export const AccountProvider = ({ children }: { children: ReactNode }) => {
    const { userId } = useAuth();
    const [account, setAccount] = useState<Account | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Only the newest request may update the figures, in case an older one finishes last
    const latestRequest = useRef(0);

    const refreshAccount = useCallback(async () => {
        const request = ++latestRequest.current;
        try {
            const response = await axios.get<Account>("/api/account");
            if (request !== latestRequest.current) return;
            setAccount(response.data);
            setError(null);
        } catch (error) {
            logError(error);
            if (request !== latestRequest.current) return;
            setError(apiErrorMessage(error));
        }
    }, []);

    useEffect(() => {
        if (!userId) return;
        // refreshAccount only sets state once its request finishes, not synchronously
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refreshAccount();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refreshAccount();
        }, POLL_MS);
        const onVisible = () => {
            if (document.visibilityState === "visible") refreshAccount();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [userId, refreshAccount]);

    return (
        <AccountContext.Provider value={{ account, error, refreshAccount }}>
            {children}
        </AccountContext.Provider>
    );
};

export const useAccount = () => useContext(AccountContext);
