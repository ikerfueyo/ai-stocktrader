"use client";

import Image from "next/image";
import { SignIn, TaskSetupMFA, useSession } from "@clerk/nextjs";
import logo from "@/public/AIStockTraderLogo.png";

// Shown on every route while signed out. Clerk's form also links to sign-up. A session still pending Clerk's "setup-mfa" task (when
// "Require multi-factor" is on in Clerk's dashboard) counts as signed out until the user sets up a second factor here.
function SignInPage() {
    const { session } = useSession();
    if (session?.currentTask?.key === "setup-mfa") {
        return (
            <div className="sign-in-page">
                <div className="sign-in-brand">
                    <Image src={logo} alt="AI StockTrader Logo" className="logo mr-2" priority />
                    AI StockTrader
                </div>
                <TaskSetupMFA redirectUrlComplete="/" />
            </div>
        );
    }
    return (
        <div className="sign-in-page">
            <div className="sign-in-brand">
                <Image src={logo} alt="AI StockTrader Logo" className="logo mr-2" priority />
                AI StockTrader
            </div>
            <SignIn routing="hash" />
        </div>
    );
};

export default SignInPage;
