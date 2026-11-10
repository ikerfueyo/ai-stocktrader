import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
// Bootstrap 4 first, so Tailwind and the app's own classes win where class names overlap (mt-5, py-4, mr-2, shadow-lg)
import "bootstrap/dist/css/bootstrap.min.css";
import "./globals.css";
import "./App.css";
import AppShell from "@/components/AppShell";
import { connection } from "next/server";
import { BrokerInfoProvider } from "@/context/BrokerInfoContext";
import { brokerMode } from "@/lib/server/broker/broker";
import { agreementDocuments } from "@/lib/server/agreements";

export const metadata: Metadata = {
    title: "AI StockTrader",
    description: "Web site for trading stocks using AI",
    icons: { icon: "/AIStockTraderLogo.png", apple: "/AIStockTraderLogo.png" },
    manifest: "/manifest.json"
};

export const viewport: Viewport = {
    themeColor: "#000000"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
    // Read at request time, not baked in at build: BROKER and AGREEMENT_DOCUMENTS are the running server's
    await connection();
    const brokerInfo = { simulated: brokerMode() === "sim", agreements: agreementDocuments() };
    return (
        <html lang="en">
            <body>
                <ClerkProvider>
                    <BrokerInfoProvider value={brokerInfo}>
                        <AppShell>{children}</AppShell>
                    </BrokerInfoProvider>
                </ClerkProvider>
            </body>
        </html>
    );
}
