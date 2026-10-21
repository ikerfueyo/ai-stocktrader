import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider, getToken } from "@clerk/react";
import axios from "axios";
import './index.css';
import App from './App';
import { AccountProvider } from './context/AccountContext';

// Every API route needs a signed-in user, so each request carries the Clerk session token
axios.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ClerkProvider publishableKey={process.env.REACT_APP_CLERK_PUBLISHABLE_KEY}>
    <BrowserRouter>
      <AccountProvider>
        <App />
      </AccountProvider>
    </BrowserRouter>
  </ClerkProvider>
);
