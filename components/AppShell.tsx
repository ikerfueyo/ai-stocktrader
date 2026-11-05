"use client";

import type { ReactNode } from "react";
import { Show, useAuth } from "@clerk/nextjs";
import AccountGate from "./AccountGate";
import SignInPage from "./SignInPage";

// Every page needs a signed-in user, since every API route does, and an open brokerage account (AccountGate)
const AppShell = ({ children }: { children: ReactNode }) => {
    const { userId } = useAuth();

    return (
        <Show when="signed-in" fallback={<SignInPage />}>
            {/* A new user gets a new gate and provider, with none of the previous user's accounts or figures */}
            <AccountGate key={userId}>
                {children}
            </AccountGate>
        </Show>
    );
};

export default AppShell;
