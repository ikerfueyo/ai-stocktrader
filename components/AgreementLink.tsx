"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useBrokerInfo } from "@/context/BrokerInfoContext";
import { PLACEHOLDER_REVISION, type AgreementDocumentName, type ShownRevisions } from "@/lib/agreements";

// A link to an agreement or disclosure in force (the broker's document, or the placeholder page), with the revision shown beside it
const AgreementLink = ({ name, children }: { name: AgreementDocumentName; children: ReactNode }) => {
    const { href, revision } = useBrokerInfo().agreements[name];
    return (
        <>
            {href.startsWith("/") ? <Link href={href} target="_blank">{children}</Link> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>}
            {revision !== PLACEHOLDER_REVISION && <small className="text-muted"> (rev. {revision})</small>}
        </>
    );
};

// The revisions of the documents a form showed, sent with the signature
export const useShownRevisions = () => {
    const { agreements } = useBrokerInfo();
    return (names: readonly AgreementDocumentName[]): ShownRevisions => Object.fromEntries(names.map(name => [name, agreements[name].revision]));
};

export default AgreementLink;
