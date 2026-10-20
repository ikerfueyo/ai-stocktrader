import React from "react";
import { Link } from "react-router-dom";
import logo from "../AIStockTraderLogo.png";
import TickerSearchBar from "./TickerSearchBar";

const Header = () => {
    return (
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
            <nav className="header-nav">
                <Link to="/portfolio" className="text-lg font-semibold mr-4">Portfolio</Link>
                <Link to="/transactions" className="text-lg font-semibold">Transactions</Link>
            </nav>
        </header>
    );
};

export default Header;
