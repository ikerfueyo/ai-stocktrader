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

// Loads /api/account once per signed-in user for the whole app, so the header keeps its figures across pages.
// Trades and transfers call refreshAccount afterwards. AppShell keys it by user ID, so another user (or none) never sees the
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
        // refreshAccount only sets state once its request finishes, not synchronously
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (userId) refreshAccount();
    }, [userId, refreshAccount]);

    return (
        <AccountContext.Provider value={{ account, error, refreshAccount }}>
            {children}
        </AccountContext.Provider>
    );
};

export const useAccount = () => useContext(AccountContext);
