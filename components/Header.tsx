"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import logo from "@/public/AIStockTraderLogo.png";
import TickerSearchBar from "./TickerSearchBar";
import AccountSummary from "./AccountSummary";
import MarginBanner from "./MarginBanner";
import AccountSwitcher from "./AccountSwitcher";
import NotificationBell from "./NotificationBell";

const NAV_LINKS = [
    { href: "/portfolio", label: "Portfolio" },
    { href: "/transactions", label: "Transactions" },
    { href: "/documents", label: "Documents" }
];

const Header = () => {
    const pathname = usePathname();
    const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
    return (
        <Fragment>
            <header className="header-container">
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
                    {NAV_LINKS.map(({ href, label }) => (
                        <Link key={href} href={href} className={`nav-link-item${isActive(href) ? " active" : ""}`} aria-current={isActive(href) ? "page" : undefined}>
                            {label}
                        </Link>
                    ))}
                    <span className="header-nav-spacer" aria-hidden="true" />
                    <Link href="/deposit" className="header-pill deposit">Deposit</Link>
                    <Link href="/withdraw" className="header-pill withdraw">Withdraw</Link>
                    <span className="header-divider" aria-hidden="true" />
                    <NotificationBell />
                    <Link href="/settings" className={`settings-link${isActive("/settings") ? " active" : ""}`} aria-label="Settings" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </Link>
                    <AccountSwitcher />
                    <UserButton />
                </nav>
            </header>
            <MarginBanner />
        </Fragment>
    );
};

export default Header;
