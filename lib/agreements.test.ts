import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseAgreementDocuments, PLACEHOLDER_REVISION, staleRevisions } from "./agreements";

describe("agreement documents", () => {
    test("without AGREEMENT_DOCUMENTS, each is the placeholder page", () => {
        const documents = parseAgreementDocuments(undefined);
        assert.deepEqual(documents.customer_agreement, { href: "/agreements/customer_agreement", revision: PLACEHOLDER_REVISION });
        assert.equal(documents.privacy_notice.href, "/agreements/privacy_notice");
    });

    test("configured documents replace the placeholders; a malformed one is refused", () => {
        const documents = parseAgreementDocuments(JSON.stringify({ customer_agreement: { url: "https://files.example.com/customer.pdf", revision: " 19.2026.10 " } }));
        assert.deepEqual(documents.customer_agreement, { href: "https://files.example.com/customer.pdf", revision: "19.2026.10" });
        assert.equal(documents.account_agreement.revision, PLACEHOLDER_REVISION);
        assert.throws(() => parseAgreementDocuments(JSON.stringify({ options_agreement: { url: "https://x", revision: "1" } })), /unknown document/);
        assert.throws(() => parseAgreementDocuments(JSON.stringify({ margin_agreement: { url: "http://x", revision: "1" } })), /https url/);
        assert.throws(() => parseAgreementDocuments(JSON.stringify({ margin_agreement: { url: "https://x" } })), /revision/);
    });

    test("a signature is refused when a document changed after the page showed it, or no revision was sent", () => {
        const documents = parseAgreementDocuments(JSON.stringify({ margin_agreement: { url: "https://x", revision: "2" } }));
        assert.deepEqual(staleRevisions(["customer_agreement", "margin_agreement"], { customer_agreement: PLACEHOLDER_REVISION, margin_agreement: "2" }, documents), []);
        assert.deepEqual(staleRevisions(["margin_agreement"], { margin_agreement: "1" }, documents), ["margin_agreement"]);
        assert.deepEqual(staleRevisions(["customer_agreement"], undefined, documents), ["customer_agreement"]);
    });
});
