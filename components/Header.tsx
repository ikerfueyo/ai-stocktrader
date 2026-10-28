"use client";

import { Fragment } from "react";
import Link from "next/link";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import logo from "@/public/AIStockTraderLogo.png";
import TickerSearchBar from "./TickerSearchBar";
import AccountSummary from "./AccountSummary";
import MarginBanner from "./MarginBanner";
import AccountSwitcher from "./AccountSwitcher";
import NotificationBell from "./NotificationBell";

const Header = () => {
    return (
        <Fragment>
            <header className="py-4 shadow-lg header-container">
                <div className="header-left">
                    <Link href="/" className="text-2xl font-extrabold flex items-center">
                        <Image
                            src={logo}
                            alt="AI StockTrader Logo"
                            className="logo mr-2"
                            priority
                        />
                        AI StockTrader
                    </Link>
                    <TickerSearchBar className="header-search" />
                </div>
                <AccountSummary />
                <nav className="header-nav">
                    <Link href="/portfolio" className="text-lg font-semibold mr-4">Portfolio</Link>
                    <Link href="/transactions" className="text-lg font-semibold mr-4">Transactions</Link>
                    <Link href="/documents" className="text-lg font-semibold mr-4">Documents</Link>
                    <Link href="/deposit" className="header-pill deposit mr-2">Deposit</Link>
                    <Link href="/withdraw" className="header-pill withdraw mr-4">Withdraw</Link>
                    <NotificationBell />
                    <AccountSwitcher />
                    <UserButton />
                </nav>
            </header>
            <MarginBanner />
        </Fragment>
    );
};

export default Header;
