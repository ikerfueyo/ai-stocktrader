import React from "react";
import { Link } from "react-router-dom";
import logo from "../AIStockTraderLogo.png";

const Header = () => {
    return (
        <header className="py-4 shadow-lg header-container">
            <div className="left-container">
                <Link to="/transactions" className="text-lg font-semibold">Transactions</Link>
            </div>
            <div className="center-container">
                <Link to="/" className="text-2xl font-extrabold text-blue-500 flex items-center justify-center">
                    <img 
                        src={logo} 
                        alt="AI StockTrader Logo" 
                        className="logo mr-2" 
                    />
                    AI StockTrader
                </Link>
            </div>
        </header>
    );
};

export default Header;