import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
// Bootstrap 4 first, so Tailwind and the app's own classes win where class names overlap (mt-5, py-4, mr-2, shadow-lg)
import "bootstrap/dist/css/bootstrap.min.css";
import "./globals.css";
import "./App.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
    title: "AI StockTrader",
    description: "Web site for trading stocks using AI",
    icons: { icon: "/AIStockTraderLogo.png", apple: "/AIStockTraderLogo.png" },
    manifest: "/manifest.json"
};

export const viewport: Viewport = {
    themeColor: "#000000"
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body>
                <ClerkProvider>
                    <AppShell>{children}</AppShell>
                </ClerkProvider>
            </body>
        </html>
    );
}
