import React, { Fragment } from "react";
import { Link } from "react-router-dom";
import { UserButton } from "@clerk/react";
import logo from "../AIStockTraderLogo.png";
import TickerSearchBar from "./TickerSearchBar";
import AccountSummary from "./AccountSummary";
import MarginBanner from "./MarginBanner";

const Header = () => {
    return (
        <Fragment>
            <header className="py-4 shadow-lg header-container">
                <div className="header-left">
                    <Link to="/" className="text-2xl font-extrabold flex items-center">
                        <img
                            src={logo}
                            alt="AI StockTrader Logo"
                            className="logo mr-2"
                        />
                        AI StockTrader
                    </Link>
                    <TickerSearchBar className="header-search" />
                </div>
                <AccountSummary />
                <nav className="header-nav">
                    <Link to="/portfolio" className="text-lg font-semibold mr-4">Portfolio</Link>
                    <Link to="/transactions" className="text-lg font-semibold mr-4">Transactions</Link>
                    <Link to="/deposit" className="header-pill deposit mr-2">Deposit</Link>
                    <Link to="/withdraw" className="header-pill withdraw mr-4">Withdraw</Link>
                    <UserButton />
                </nav>
            </header>
            <MarginBanner />
        </Fragment>
    );
};

export default Header;
