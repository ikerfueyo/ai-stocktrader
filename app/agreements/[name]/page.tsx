import { notFound } from "next/navigation";
import Link from "next/link";

// The simulator's placeholder agreements and disclosures. Each says what the real document covers; with a real broker
// (BROKER=alpaca) the onboarding form links to the broker's own documents instead.
const DOCUMENTS: Record<string, { title: string; covers: string[] }> = {
    customer_agreement: {
        title: "Customer agreement",
        covers: [
            "The terms between you and the broker that holds your account: how orders are handled and executed, fees, statements and confirmations.",
            "That you direct your own trades, and that the app's AI analysis isn't a recommendation by the broker.",
            "Arbitration of disputes, how the agreement can change, and how either side can close the account."
        ]
    },
    account_agreement: {
        title: "Account agreement",
        covers: [
            "How the account is opened and kept: identity verification, keeping your details current, and when the account can be restricted.",
            "Settlement of trades (T+1), how cash and securities are held, and SIPC coverage.",
            "Tax reporting: Form W-9, backup withholding and the yearly 1099 forms."
        ]
    },
    margin_agreement: {
        title: "Margin agreement",
        covers: [
            "Borrowing against the stocks in your account, the interest charged on what you borrow, and short selling.",
            "That you can lose more than you deposit, and that the broker can raise its requirements at any time.",
            "Margin calls: when the account falls below its maintenance requirement, the broker can sell your positions without notice to cover it."
        ]
    },
    options_agreement: {
        title: "Options agreement",
        covers: [
            "The risks of options described in the Characteristics and Risks of Standardized Options, which you must read first.",
            "Exercise and assignment, expiration, and the levels of options trading the broker approves you for.",
            "That options can expire worthless, and that selling options can lose more than the premium received."
        ]
    },
    form_crs: {
        title: "Relationship summary (Form CRS)",
        covers: [
            "The services the broker offers retail investors, what they cost, and the conflicts of interest the broker has.",
            "Its legal and disciplinary history, and how to get more information and report concerns."
        ]
    },
    ira_disclosure: {
        title: "IRA disclosure statement and custodial agreement",
        covers: [
            "The rules for traditional and Roth IRAs: who can contribute, the yearly limit across all your IRAs, the prior year's contributions until April 15, and the taxes and penalties on distributions, including before 59½.",
            "Your beneficiaries, how required minimum distributions work (a traditional IRA's from age 73 or 75), and the custodian's duties and fees.",
            "In this simulator: no IRA is opened anywhere, contributions and distributions move no money, and the tax forms are marked simulated."
        ]
    },
    privacy_notice: {
        title: "Privacy notice",
        covers: [
            "What personal information is collected to open and service your account, why, and with whom it's shared.",
            "In this simulator: your application is kept with the tax ID masked to its last 4 digits, uploaded documents are discarded after a fingerprint is taken, and nothing is sent to a broker."
        ]
    }
};

export default async function Agreement({ params }: { params: Promise<{ name: string }> }) {
    const document = DOCUMENTS[(await params).name];
    if (!document) notFound();
    return (
        <main className="transfer-container mt-5">
            <h1 className="transfer-title">{document.title}</h1>
            <p className="onboarding-test-note">
                AI StockTrader is a simulator, so this is a placeholder, not a contract: no account is opened at any broker. The real document
                covers:
            </p>
            <ul>{document.covers.map(line => <li key={line}>{line}</li>)}</ul>
            <p className="text-center"><Link href="/">Back to AI StockTrader</Link></p>
        </main>
    );
}
