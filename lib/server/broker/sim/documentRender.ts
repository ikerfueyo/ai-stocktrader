// The simulator's account documents as printable HTML pages (a PDF through the browser's print), from the data each keeps. Pure, so
// it can be unit tested; ./documents.ts stores the data. Every page says it's simulated: no account exists at any broker, and the
// figures aren't for filing.
import type { Form1099R, Form5498, TaxYear } from "./tax";

export interface Holder {
    name: string;
    accountNumber: string;
    address: string[];
}

export interface ConfirmationFill {
    time: string;
    side: "buy" | "sell";
    symbol: string;
    qty: number;
    price: number;
    principal: number;
    fees: { REG: number; TAF: number; CAT: number; ORF?: number; OCC?: number };
    settleDate: string | null;
    orderId: string | null;
    liquidation: boolean;
}

export interface TradeConfirmationPayload {
    holder: Holder;
    tradeDate: string;
    fills: ConfirmationFill[];
}

export interface StatementPayload {
    holder: Holder;
    periodStart: string;
    periodEnd: string;
    opening: { date: string; equity: number; cash: number } | null;
    closing: { date: string; equity: number; cash: number; longMarketValue: number; shortMarketValue: number } | null;
    summary: { deposits: number; withdrawals: number; bought: number; sold: number; dividends: number; fees: number; interest: number; withholding: number; corporateActions: number; realized: number };
    activities: { date: string; type: string; description: string; amount: number }[];
    positions: { symbol: string; qty: number; avgCost: number; costBasis: number }[];
}

export interface ApplicationPayload {
    holder: Holder;
    submittedAt: string;
    // The account as the broker holds it (Alpaca's Account, the tax ID masked)
    account: Record<string, unknown>;
    attestations: { kind: string; at: string; ipAddress: string | null; details: Record<string, unknown> }[];
}

export interface TaxStatementPayload {
    holder: Holder;
    taxYear: TaxYear;
    backupWithholding: boolean;
}

// An IRA's tax form: the 1099-R (distributions) or the 5498 (contributions and the year-end value)
export interface IraTaxPayload {
    holder: Holder;
    iraType: "traditional" | "roth";
    form: "1099-R" | "5498";
    form1099R?: Form1099R;
    form5498?: Form5498;
}

export type DocumentPayload = TradeConfirmationPayload | StatementPayload | ApplicationPayload | TaxStatementPayload | IraTaxPayload;

export interface RenderableDocument {
    type: "account_application" | "account_statement" | "tax_statement" | "trade_confirmation" | "trade_confirmation_json";
    name: string;
    date: string;
    preliminary: boolean;
    payload: DocumentPayload;
}

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
const money = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const qty = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const day = (iso: string) => iso.slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }) + " ET";

const table = (headers: string[], rows: (string | number)[][], { numeric = [] as number[] } = {}) => rows.length === 0 ? "<p class=\"muted\">None.</p>" : `
<table>
  <thead><tr>${headers.map((header, i) => `<th${numeric.includes(i) ? " class=\"num\"" : ""}>${escape(header)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map(row => `<tr>${row.map((cell, i) => `<td${numeric.includes(i) ? " class=\"num\"" : ""}>${typeof cell === "number" ? escape(String(cell)) : cell}</td>`).join("")}</tr>`).join("")}</tbody>
</table>`;

const holderBlock = (holder: Holder) => `
<div class="holder">
  <div><strong>${escape(holder.name)}</strong></div>
  ${holder.address.map(line => `<div>${escape(line)}</div>`).join("")}
  <div class="muted">Account ${escape(holder.accountNumber)}</div>
</div>`;

const confirmation = (payload: TradeConfirmationPayload) => {
    const rows = payload.fills.map(fill => {
        const fees = fill.fees.REG + fill.fees.TAF + fill.fees.CAT + (fill.fees.ORF ?? 0) + (fill.fees.OCC ?? 0);
        return [escape(time(fill.time)), `<strong>${fill.side === "buy" ? "Bought" : "Sold"}</strong>${fill.liquidation ? " <span class=\"muted\">(liquidation)</span>" : ""}`,
            escape(fill.symbol), escape(qty(fill.qty)), escape(price(fill.price)), escape(money(fill.principal)), escape(fees > 0 ? `$${fees.toFixed(6).replace(/0+$/, "")}` : "$0"),
            escape(fill.settleDate ?? ""), escape(fill.orderId ? fill.orderId.slice(0, 8) : "")];
    });
    return `${holderBlock(payload.holder)}
<p>Trades executed on ${escape(payload.tradeDate)}. Capacity: agent. Commission: $0. Regulatory fees accrue per trade and are charged at the end of the day, rounded up to the cent.</p>
${table(["Time", "Action", "Symbol", "Quantity", "Price", "Principal", "Reg. fees accrued", "Settles", "Order"], rows, { numeric: [3, 4, 5, 6] })}`;
};

const statement = (payload: StatementPayload) => {
    const { summary } = payload;
    return `${holderBlock(payload.holder)}
<p>Period: ${escape(payload.periodStart)} to ${escape(payload.periodEnd)}</p>
<h2>Account value</h2>
${table(["", "Equity", "Cash"], [
        ["Opening" + (payload.opening ? ` (${escape(payload.opening.date)})` : ""), escape(payload.opening ? money(payload.opening.equity) : "—"), escape(payload.opening ? money(payload.opening.cash) : "—")],
        ["Closing" + (payload.closing ? ` (${escape(payload.closing.date)})` : ""), escape(payload.closing ? money(payload.closing.equity) : "—"), escape(payload.closing ? money(payload.closing.cash) : "—")]
    ], { numeric: [1, 2] })}
${payload.closing ? `<p class="muted">Long market value ${escape(money(payload.closing.longMarketValue))}; short market value ${escape(money(payload.closing.shortMarketValue))}.</p>` : ""}
<h2>Summary</h2>
${table(["", "Amount"], [
        ["Deposits", escape(money(summary.deposits))], ["Withdrawals", escape(money(summary.withdrawals))], ["Securities bought", escape(money(summary.bought))],
        ["Securities sold", escape(money(summary.sold))], ["Dividends (net of charges on shorts)", escape(money(summary.dividends))], ["Fees", escape(money(summary.fees))],
        ["Margin interest", escape(money(summary.interest))], ["Backup withholding", escape(money(summary.withholding))], ["Corporate action cash", escape(money(summary.corporateActions))],
        ["Realized gain or loss (FIFO, before wash sale adjustments)", escape(money(summary.realized))]
    ], { numeric: [1] })}
<h2>Positions at the end of the period</h2>
${table(["Symbol", "Quantity", "Average cost", "Cost basis"], payload.positions.map(position => [escape(position.symbol), escape(qty(position.qty)), escape(price(position.avgCost)), escape(money(position.costBasis))]), { numeric: [1, 2, 3] })}
<h2>Activity</h2>
${table(["Date", "Type", "Description", "Amount"], payload.activities.map(entry => [escape(entry.date), escape(entry.type), escape(entry.description), escape(money(entry.amount))]), { numeric: [3] })}`;
};

const application = (payload: ApplicationPayload) => {
    const account = payload.account as { contact?: Record<string, unknown>; identity?: Record<string, unknown>; disclosures?: Record<string, unknown>; agreements?: { agreement: string; signed_at: string; ip_address: string }[]; trusted_contact?: Record<string, unknown> | null; account_type?: string };
    const fields = (section: Record<string, unknown> | undefined | null) => table(["Field", "Value"], Object.entries(section ?? {})
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([key, value]) => [escape(key.replaceAll("_", " ")), escape(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : value)]));
    return `${holderBlock(payload.holder)}
<p>Submitted ${escape(time(payload.submittedAt))}. The tax ID is kept masked to its last 4 digits.</p>
<h2>Contact</h2>${fields(account.contact)}
<h2>Identity</h2>${fields(account.identity)}
<h2>Disclosures</h2>${fields(account.disclosures)}
${account.trusted_contact ? `<h2>Trusted contact</h2>${fields(account.trusted_contact)}` : ""}
<h2>Agreements</h2>
${table(["Agreement", "Signed", "IP address"], (account.agreements ?? []).map(agreement => [escape(agreement.agreement.replaceAll("_", " ")), escape(time(agreement.signed_at)), escape(agreement.ip_address)]))}
<h2>Certifications and disclosures delivered</h2>
${table(["", "When", "IP address", "Details"], payload.attestations.map(entry => [escape(entry.kind === "w9" ? "W-9 certification" : entry.kind === "form_crs" ? "Form CRS delivered" : entry.kind === "privacy_notice" ? "Privacy notice delivered" : entry.kind === "ira_disclosure" ? "IRA disclosure statement and custodial agreement delivered" : entry.kind), escape(time(entry.at)), escape(entry.ipAddress ?? ""), escape(Object.keys(entry.details).length ? JSON.stringify(entry.details) : "")]))}`;
};

const tax = (payload: TaxStatementPayload) => {
    const { taxYear: year } = payload;
    const b = year.form1099B;
    const saleRows = (term: "short" | "long") => b.sales.filter(sale => sale.term === term).map(sale => [
        escape(`${qty(sale.qty)} ${sale.symbol}`), escape(day(sale.dateAcquired)), escape(day(sale.closedAt)), escape(money(sale.proceeds)), escape(money(sale.costBasis)),
        escape(sale.washDisallowed > 0 ? `${money(sale.washDisallowed)} W` : ""), escape(money(sale.gain)),
        escape(sale.kind === "sale" ? (sale.side === "short" ? "Short sale" : "") : sale.kind === "merger" ? "Cash merger" : sale.kind === "cash_in_lieu" ? "Cash in lieu" : "Worthless")
    ]);
    const totals = (term: "short" | "long") => `<p class="muted">Totals: proceeds ${escape(money(b.totals[term].proceeds))}, cost basis ${escape(money(b.totals[term].costBasis))}, wash sale loss disallowed ${escape(money(b.totals[term].washDisallowed))}, gain or loss ${escape(money(b.totals[term].gain))}.</p>`;
    const headers = ["1a Description", "1b Date acquired", "1c Date sold", "1d Proceeds", "1e Cost basis", "1g Wash sale loss disallowed", "Gain or loss", "Note"];
    return `${holderBlock(payload.holder)}
<p>Tax year ${year.year}. ${payload.backupWithholding ? "Backup withholding applied at 24% (the W-9 certification said the account is subject to it)." : "No backup withholding: the account's W-9 certification is on file."}</p>
<h2>1099-DIV: dividends and distributions</h2>
${table(["Box", "Amount"], [["1a Total ordinary dividends", escape(money(year.form1099DIV.ordinaryDividends))], ["1b Qualified dividends", escape(money(year.form1099DIV.qualifiedDividends))], ["4 Federal income tax withheld", escape(money(year.form1099DIV.federalWithheld))]], { numeric: [1] })}
<p class="muted">${year.form1099DIV.required ? "" : "Below the $10 reporting threshold. "}Every dividend is reported as ordinary: the simulator doesn't know which are qualified. Dividends charged on short positions aren't income and aren't included.</p>
<h2>1099-INT: interest income</h2>
${table(["Box", "Amount"], [["1 Interest income", escape(money(year.form1099INT.interestIncome))], ["4 Federal income tax withheld", escape(money(year.form1099INT.federalWithheld))]], { numeric: [1] })}
<p class="muted">${year.form1099INT.required ? "" : "Below the $10 reporting threshold. "}Margin interest charged to the account is an expense, not reported here.</p>
<h2>1099-B: proceeds from broker transactions</h2>
<p>Box 4 federal income tax withheld: ${escape(money(b.federalWithheld))}. Every sale below is of covered securities (basis reported to the IRS). Lots are closed first in, first out.</p>
<h3>Short-term (held one year or less)</h3>
${table(headers, saleRows("short"), { numeric: [3, 4, 5, 6] })}
${totals("short")}
<h3>Long-term (held more than one year)</h3>
${table(headers, saleRows("long"), { numeric: [3, 4, 5, 6] })}
${totals("long")}
<p class="muted">W: a loss disallowed by the wash sale rule (shares of the same security bought within 30 days before or after the sale), added to the replacement shares' basis. Wash sales are found within this account only.</p>`;
};

const iraTax = (payload: IraTaxPayload) => {
    const label = payload.iraType === "roth" ? "Roth IRA" : "Traditional IRA";
    if (payload.form === "5498" && payload.form5498) {
        const form = payload.form5498;
        return `${holderBlock(payload.holder)}
<p>Form 5498, IRA contribution information, for tax year ${form.year} (${escape(label)}). Contributions for ${form.year} include those made through April 15, ${form.year + 1}.</p>
${table(["Box", "Amount"], [
            [form.traditional ? "1 IRA contributions" : "10 Roth IRA contributions", escape(money(form.contributions))],
            ["5 Fair market value of account (December 31)", escape(money(form.fairMarketValue))],
            ["7 IRA type", escape(form.traditional ? "IRA" : "Roth IRA")],
            ["11 Required minimum distribution for next year", escape(form.rmdNextYear ? "Yes (an RMD notice follows; the simulator doesn't work out the amount)" : "No")]
        ], { numeric: [1] })}
<p class="muted">Contributions are reported as made; whether they're deductible (traditional) or allowed (Roth, by income) is for the owner's return.</p>`;
    }
    const form = payload.form1099R!;
    return `${holderBlock(payload.holder)}
<p>Form 1099-R, distributions from an IRA, for tax year ${form.year} (${escape(label)}). One form per distribution code.</p>
${form.lines.length === 0 ? "<p>No distributions this year.</p>" : table(["Box 7 code", "1 Gross distribution", "2a Taxable amount", "2b Taxable amount not determined", "4 Federal income tax withheld", "14 State tax withheld", "IRA/SEP/SIMPLE"],
        form.lines.map(line => [escape(line.code), escape(money(line.gross)), escape(line.taxable === null ? "" : money(line.taxable)), escape(line.taxableNotDetermined ? "X" : ""), escape(money(line.fedWithheld)), escape(money(line.stateWithheld)), escape(form.traditional ? "X" : "")]),
        { numeric: [1, 2, 4, 5] })}
<p class="muted">Codes: 1 early distribution, no known exception; 7 normal distribution; 8, 81, P and P1 removals of excess contributions; Q qualified Roth distribution; J early Roth distribution; 8J and PJ Roth excess removals. A traditional IRA's distributions are taxable in full (no basis is tracked).</p>`;
};

// The document as a full HTML page
export const renderDocument = (document: RenderableDocument): string => {
    const body = document.type === "trade_confirmation" || document.type === "trade_confirmation_json" ? confirmation(document.payload as TradeConfirmationPayload)
        : document.type === "account_statement" ? statement(document.payload as StatementPayload)
            : document.type === "account_application" ? application(document.payload as ApplicationPayload)
                : "form" in document.payload ? iraTax(document.payload as IraTaxPayload)
                    : tax(document.payload as TaxStatementPayload);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(document.name)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #212529; background: #fff; margin: 24px auto; max-width: 960px; padding: 0 16px; font-size: 14px; }
  h1 { font-size: 22px; margin-bottom: 4px; } h2 { font-size: 17px; margin-top: 28px; } h3 { font-size: 15px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; } th, td { border-bottom: 1px solid #dee2e6; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f8f9fa; font-weight: 600; } .num { text-align: right; white-space: nowrap; } .muted { color: #6c757d; }
  .banner { border: 2px solid #dc3545; color: #dc3545; padding: 8px 12px; margin: 12px 0; font-weight: 600; } .holder { margin: 16px 0; }
  .toolbar { margin: 12px 0; } @media print { .toolbar { display: none; } body { margin: 0; } }
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Print or save as PDF</button></div>
<h1>${escape(document.name)}</h1>
<div class="muted">AI StockTrader (simulated brokerage) · Dated ${escape(document.date)}</div>
<div class="banner">Simulated document${document.preliminary ? ", preliminary" : ""}: AI StockTrader is a simulation. No account exists at any broker, no money moved and no trades are real. Not for tax filing.</div>
${body}
</body>
</html>`;
};
