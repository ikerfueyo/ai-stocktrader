import "server-only";
import { HttpError } from "./httpError";
import { AGREEMENT_TITLES, parseAgreementDocuments, staleRevisions, type AgreementDocumentName, type AgreementDocuments, type ShownRevisions } from "../agreements";

// The agreements and disclosures in force: AGREEMENT_DOCUMENTS (JSON, { name: { url, revision } }, Alpaca's links and revisions for
// its agreements, counsel's for the app's own Form CRS and privacy notice), else the placeholders. Read once per process.
let documents: AgreementDocuments | null = null;
export const agreementDocuments = (): AgreementDocuments => (documents ??= parseAgreementDocuments(process.env.AGREEMENT_DOCUMENTS));

// The revision to record with a signature (a placeholder's isn't sent to the broker, which then uses its current one)
export const brokerRevision = (name: AgreementDocumentName) => {
    const { revision } = agreementDocuments()[name];
    return revision === "placeholder" ? {} : { revision };
};

// 409 when a document was updated after the page showed it (or the page didn't say which revision it showed)
export const requireCurrentRevisions = (names: readonly AgreementDocumentName[], shown: unknown) => {
    const stale = staleRevisions(names, (shown && typeof shown === "object" ? shown : undefined) as ShownRevisions | undefined, agreementDocuments());
    if (stale.length > 0) {
        throw new HttpError(`Updated since you opened this page: the ${stale.map(name => AGREEMENT_TITLES[name]).join(", ")}. Reload the page and review ${stale.length > 1 ? "them" : "it"} again.`, 409);
    }
};
