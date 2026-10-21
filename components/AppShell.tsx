"use client";

import type { ReactNode } from "react";
import { Show, useAuth } from "@clerk/nextjs";
import { AccountProvider } from "@/context/AccountContext";
import SignInPage from "./SignInPage";

// Every page needs a signed-in user, since every API route does
const AppShell = ({ children }: { children: ReactNode }) => {
    const { userId } = useAuth();

    return (
        <Show when="signed-in" fallback={<SignInPage />}>
            {/* A new user gets a new provider, with none of the previous user's figures */}
            <AccountProvider key={userId}>
                {children}
            </AccountProvider>
        </Show>
    );
};

export default AppShell;
