import React from "react";
import { SignIn } from "@clerk/react";
import logo from "../AIStockTraderLogo.png";

// Shown on every route while signed out. Clerk's form also links to sign-up.
function SignInPage() {
    return (
        <div className="sign-in-page">
            <div className="sign-in-brand">
                <img src={logo} alt="AI StockTrader Logo" className="logo mr-2" />
                AI StockTrader
            </div>
            <SignIn routing="hash" />
        </div>
    );
};

export default SignInPage;
