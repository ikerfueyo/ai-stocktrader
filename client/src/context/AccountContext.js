import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import axios from "axios";
import { useAuth } from "@clerk/react";

const AccountContext = createContext({ account: null, error: null, refreshAccount: () => {} });

// Loads /account once per signed-in user for the whole app, so the header keeps its figures across pages.
// Trades and transfers call refreshAccount afterwards.
export const AccountProvider = ({ children }) => {
    const { userId } = useAuth();
    const [account, setAccount] = useState(null);
    const [error, setError] = useState(null);
    // Only the newest request may update the figures, in case an older one finishes last
    const latestRequest = useRef(0);

    const refreshAccount = useCallback(async () => {
        const request = ++latestRequest.current;
        try {
            const response = await axios.get("/account");
            if (request !== latestRequest.current) return;
            setAccount(response.data);
            setError(null);
        } catch (error) {
            console.error(error.message);
            if (request !== latestRequest.current) return;
            setError(error.response?.data?.error ?? error.message);
        }
    }, []);

    useEffect(() => {
        // Another user (or none) mustn't see the previous user's figures, or a response still on its way for them
        latestRequest.current++;
        setAccount(null);
        setError(null);
        if (userId) refreshAccount();
    }, [userId, refreshAccount]);

    return (
        <AccountContext.Provider value={{ account, error, refreshAccount }}>
            {children}
        </AccountContext.Provider>
    );
};

export const useAccount = () => useContext(AccountContext);
