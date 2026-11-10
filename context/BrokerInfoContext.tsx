"use client";

import { createContext, useContext, type ReactNode } from "react";
import { placeholderDocuments, type AgreementDocuments } from "@/lib/agreements";

// What the pages need to know about the broker in use, from the server (app/layout.tsx): whether it's the simulator (whose test notes
// show only then) and the agreements and disclosures in force, with their revisions
export interface BrokerInfo {
    simulated: boolean;
    agreements: AgreementDocuments;
}

const BrokerInfoContext = createContext<BrokerInfo>({ simulated: true, agreements: placeholderDocuments() });

export const BrokerInfoProvider = ({ value, children }: { value: BrokerInfo; children: ReactNode }) =>
    <BrokerInfoContext.Provider value={value}>{children}</BrokerInfoContext.Provider>;

export const useBrokerInfo = () => useContext(BrokerInfoContext);
