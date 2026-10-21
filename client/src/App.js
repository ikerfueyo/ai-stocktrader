import React from "react";
import './App.css';
import { Routes, Route } from "react-router-dom";
import { Show } from "@clerk/react";
import Home from "./pages/Home";
import Trading from "./pages/Trading";
import Transactions from "./pages/Transactions";
import Portfolio from "./pages/Portfolio";
import Deposit from "./pages/Deposit";
import Withdraw from "./pages/Withdraw";
import SignInPage from "./pages/SignInPage";

// Every page needs a signed-in user, since every API route does
function App() {
  return (
    <Show when="signed-in" fallback={<SignInPage />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/trading/:ticker" element={<Trading />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/deposit" element={<Deposit />} />
        <Route path="/withdraw" element={<Withdraw />} />
      </Routes>
    </Show>
  );
};

export default App;
