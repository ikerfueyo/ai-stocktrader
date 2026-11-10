// The agreements and disclosures a user accepts or receives, and which revision of each was shown (shared by the pages and the
// server; pure). With Alpaca the documents and their revisions come from AGREEMENT_DOCUMENTS (lib/server/agreements.ts); without
// it each is the app's placeholder page at /agreements/<name>, revision "placeholder". The pages send the revisions they showed, and
// the server refuses a signature whose revision is no longer the current one, so signed_at and the IP always refer to the version shown.

export const AGREEMENT_DOCUMENT_NAMES = ["customer_agreement", "account_agreement", "margin_agreement", "form_crs", "ira_disclosure", "privacy_notice"] as const;
export type AgreementDocumentName = typeof AGREEMENT_DOCUMENT_NAMES[number];

export const PLACEHOLDER_REVISION = "placeholder";

export interface AgreementDocument {
    // Where the page links: the broker's document, or the placeholder page
    href: string;
    revision: string;
}

export type AgreementDocuments = Record<AgreementDocumentName, AgreementDocument>;

// The revisions shown, as the pages send them: { customer_agreement: "19.2026.10", ... }
export type ShownRevisions = Partial<Record<AgreementDocumentName, string>>;

export const placeholderDocuments = (): AgreementDocuments =>
    Object.fromEntries(AGREEMENT_DOCUMENT_NAMES.map(name => [name, { href: `/agreements/${name}`, revision: PLACEHOLDER_REVISION }])) as AgreementDocuments;

// Reads AGREEMENT_DOCUMENTS' JSON ({ name: { url, revision } }) over the placeholders; throws on a malformed value, so a typo can't
// silently show placeholders to real customers
export const parseAgreementDocuments = (value: string | undefined): AgreementDocuments => {
    const documents = placeholderDocuments();
    if (!value?.trim()) return documents;
    const parsed = JSON.parse(value) as Record<string, { url?: unknown; revision?: unknown }>;
    for (const [name, entry] of Object.entries(parsed)) {
        if (!(AGREEMENT_DOCUMENT_NAMES as readonly string[]).includes(name)) throw new Error(`AGREEMENT_DOCUMENTS: unknown document ${name}`);
        if (typeof entry?.url !== "string" || !/^https:\/\//.test(entry.url)) throw new Error(`AGREEMENT_DOCUMENTS: ${name} needs an https url`);
        if (typeof entry.revision !== "string" || !entry.revision.trim()) throw new Error(`AGREEMENT_DOCUMENTS: ${name} needs a revision`);
        documents[name as AgreementDocumentName] = { href: entry.url, revision: entry.revision.trim() };
    }
    return documents;
};

// The documents whose shown revision isn't the current one (or wasn't sent), for a 409 asking to review them again
export const staleRevisions = (names: readonly AgreementDocumentName[], shown: ShownRevisions | undefined, documents: AgreementDocuments): AgreementDocumentName[] =>
    names.filter(name => shown?.[name] !== documents[name].revision);

export const AGREEMENT_TITLES: Record<AgreementDocumentName, string> = {
    customer_agreement: "customer agreement",
    account_agreement: "account agreement",
    margin_agreement: "margin agreement",
    form_crs: "relationship summary (Form CRS)",
    ira_disclosure: "IRA disclosure statement and custodial agreement",
    privacy_notice: "privacy notice"
};
