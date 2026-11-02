"use client";

import Image from "next/image";
import { SignIn } from "@clerk/nextjs";
import logo from "@/public/AIStockTraderLogo.png";

// Shown on every route while signed out. Clerk's form also links to sign-up.
function SignInPage() {
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
