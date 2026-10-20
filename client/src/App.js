import React from "react";
import './App.css';
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Trading from "./pages/Trading";
import Transactions from "./pages/Transactions";
import Portfolio from "./pages/Portfolio";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/trading/:ticker" element={<Trading />} />
      <Route path="/transactions" element={<Transactions />} />
      <Route path="/portfolio" element={<Portfolio />} />
    </Routes>
  );
};

export default App;
