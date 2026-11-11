"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import axios from "axios";
import { UserButton } from "@clerk/nextjs";
import logo from "@/public/AIStockTraderLogo.png";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { BrokerAccountContext } from "@/context/BrokerAccountContext";
import { AccountProvider } from "@/context/AccountContext";
import OnboardingWizard from "./OnboardingWizard";
import ApplicationStatus from "./ApplicationStatus";
import { OPEN_ACCOUNT_STATUSES } from "@/lib/accounts";
import { useBrokerInfo } from "@/context/BrokerInfoContext";
import AgreementLink from "./AgreementLink";
import type { BrokerAccountSummary } from "@/lib/types";

// Statuses a review is still working through, polled until they change
const PENDING_STATUSES = ["SUBMITTED", "APPROVAL_PENDING", "APPROVED", "ACTION_REQUIRED"];
const POLL_MS = 3000;
// lib/server/requestContext.ts's ACCOUNT_HEADER (a server-only module)
const ACCOUNT_HEADER = "X-Account-Id";

// A bare header for the screens before an account is open: the logo and the user menu (to sign out)
export const OnboardingHeader = () => (
    <header className="py-4 shadow-lg header-container onboarding-header">
        <div className="header-left">
            <span className="text-2xl font-extrabold flex items-center">
                <Image src={logo} alt="AI StockTrader Logo" className="logo mr-2" priority />
                AI StockTrader
            </span>
        </div>
        <nav className="header-nav"><UserButton /></nav>
    </header>
);

// Between sign-in and the app: a user without an open brokerage account applies for one (OnboardingWizard) or follows its review
// (ApplicationStatus); with one, the app opens with its figures (AccountProvider). The agreement pages are readable either way.
const AccountGate = ({ children }: { children: ReactNode }) => {
    const pathname = usePathname();
    const { simulated } = useBrokerInfo();
    const [accounts, setAccounts] = useState<BrokerAccountSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Set when the user chooses to apply again after a rejection or a closed account
    const [reapplying, setReapplying] = useState(false);

    const refreshAccounts = useCallback(async () => {
        try {
            setAccounts((await axios.get<BrokerAccountSummary[]>("/api/accounts")).data);
            setError(null);
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        }
    }, []);

    useEffect(() => {
        // refreshAccounts only sets state once its request finishes
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refreshAccounts();
    }, [refreshAccounts]);

    const active = accounts?.find(account => account.active) ?? null;
    const pending = active !== null && PENDING_STATUSES.includes(active.status);
    // Every request from this tab names the open account it shows (X-Account-Id), so switching accounts in another tab can't send this
    // tab's orders, transfers or settings to the other account. Set in a layout effect, which runs before the children's effects fetch.
    const shownAccountId = active && OPEN_ACCOUNT_STATUSES.includes(active.status) ? active.accountId : null;
    useLayoutEffect(() => {
        if (shownAccountId) axios.defaults.headers.common[ACCOUNT_HEADER] = shownAccountId;
        else delete axios.defaults.headers.common[ACCOUNT_HEADER];
    }, [shownAccountId]);
    useEffect(() => {
        if (!pending) return;
        const timer = setInterval(refreshAccounts, POLL_MS);
        return () => clearInterval(timer);
    }, [pending, refreshAccounts]);

    if (pathname.startsWith("/agreements")) return <>{children}</>;

    let screen: ReactNode;
    if (error && accounts === null) {
        screen = <p className="text-danger text-center mt-5">Couldn&apos;t load your account: {error}</p>;
    } else if (accounts === null) {
        screen = <p className="text-center mt-5">Loading...</p>;
    } else if (active && OPEN_ACCOUNT_STATUSES.includes(active.status)) {
        return (
            <BrokerAccountContext.Provider value={{ accounts, active, refreshAccounts }}>
                <AccountProvider key={active.accountId}>{children}</AccountProvider>
            </BrokerAccountContext.Provider>
        );
    } else if (!active || reapplying) {
        screen = <OnboardingWizard onSubmitted={async () => { setReapplying(false); await refreshAccounts(); }} />;
    } else {
        screen = <ApplicationStatus account={active} onChanged={refreshAccounts} onReapply={() => setReapplying(true)} />;
    }
    return (
        <BrokerAccountContext.Provider value={{ accounts: accounts ?? [], active, refreshAccounts }}>
            <OnboardingHeader />
            {screen}
            <p className="mock-note">
                {simulated && "AI StockTrader is a simulation: no brokerage account is opened, no money moves and no trades are real. "}<AgreementLink name="privacy_notice">Privacy notice</AgreementLink>
            </p>
        </BrokerAccountContext.Provider>
    );
};

export default AccountGate;
