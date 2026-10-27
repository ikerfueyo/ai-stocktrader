"use client";

import { createContext, useContext } from "react";
import type { BrokerAccountSummary } from "@/lib/types";

interface BrokerAccountContextValue {
    // The user's brokerage accounts, newest first, and the one requests act on
    accounts: BrokerAccountSummary[];
    active: BrokerAccountSummary | null;
    refreshAccounts: () => Promise<void>;
}

export const BrokerAccountContext = createContext<BrokerAccountContextValue>({ accounts: [], active: null, refreshAccounts: async () => {} });

// The brokerage accounts AccountGate loaded (/api/accounts)
export const useBrokerAccount = () => useContext(BrokerAccountContext);
