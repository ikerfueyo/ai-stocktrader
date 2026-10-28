"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, formatPrice, formatShares } from "@/lib/orders";
import type { BrokerDocument, TaxReport } from "@/lib/types";

export type DocumentsTab = "documents" | "gains";

const TYPE_LABELS: Record<string, string> = {
    trade_confirmation: "Trade confirmation", trade_confirmation_json: "Trade confirmation (JSON)", account_statement: "Account statement",
    tax_statement: "Tax statement (1099)", account_application: "Account application"
};
const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => thisYear - i);
const signed = (value: number) => `${value < 0 ? "-" : "+"}${formatCurrency(Math.abs(value))}`;
const gainClass = (value: number | null) => value === null ? "" : `price-change ${value >= 0 ? "positive" : "negative"}`;
const day = (iso: string) => iso.slice(0, 10);

// Documents (trade confirmations, monthly statements, the consolidated 1099, the account application), each opening as a page to print
// or save as PDF, by type and year; and the gains and losses report for a tax year with the open lots' unrealized gains. Tabs kept in
// the URL as ?tab=.
const DocumentsPage = ({ tab = "documents" }: { tab?: DocumentsTab }) => (
    <div className="documents-page">
        <ul className="nav nav-tabs history-tabs mt-5">
            {[["documents", "Documents"], ["gains", "Gains & losses"]].map(([id, label]) => (
                <li className="nav-item" key={id}>
                    <Link href={`/documents?tab=${id}`} className={`nav-link ${tab === id ? "active" : ""}`} aria-current={tab === id ? "page" : undefined}>{label}</Link>
                </li>
            ))}
        </ul>
        {tab === "documents" ? <DocumentList /> : <GainsReport />}
    </div>
);

const DocumentList = () => {
    const [year, setYear] = useState<number | "all">(thisYear);
    const [type, setType] = useState("");
    const [documents, setDocuments] = useState<BrokerDocument[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const [making, setMaking] = useState(false);

    useEffect(() => {
        const load = async () => {
            setDocuments(null);
            try {
                const params = new URLSearchParams({ ...(year === "all" ? {} : { year: String(year) }), ...(type ? { type } : {}) });
                setDocuments((await axios.get<BrokerDocument[]>(`/api/documents?${params}`)).data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        load();
    }, [year, type, version]);

    const onPreliminary = async () => {
        setMaking(true);
        try {
            await axios.post("/api/dev/documents", { year: year === "all" ? thisYear : year });
            setVersion(v => v + 1);
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setMaking(false);
        }
    };

    return (
        <Fragment>
            <div className="activity-toolbar mt-3">
                <label>
                    Year{" "}
                    <select className="form-control form-control-sm d-inline-block w-auto" value={year} onChange={e => setYear(e.target.value === "all" ? "all" : Number(e.target.value))}>
                        {YEARS.map(option => <option key={option} value={option}>{option}</option>)}
                        <option value="all">All</option>
                    </select>
                </label>
                <label>
                    Type{" "}
                    <select className="form-control form-control-sm d-inline-block w-auto" value={type} onChange={e => setType(e.target.value)}>
                        <option value="">All</option>
                        {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </label>
                {process.env.NODE_ENV !== "production" && (
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onPreliminary} disabled={making}
                        title="Development only: this month's statement, today's confirmation and the year's 1099 so far, marked preliminary">
                        {making ? "Making…" : "Make preliminary documents"}
                    </button>
                )}
            </div>
            <p className="text-muted">
                Trade confirmations arrive the day after a trading day with trades, statements after each month&apos;s first weekend, and the consolidated 1099 by February 15.
                Each opens as a page to print or save as PDF. They&apos;re simulated: not for tax filing.
            </p>
            {error ? <p className="text-danger">Couldn&apos;t load your documents: {error}</p> : documents === null ? <p>Loading...</p> : documents.length === 0 ? <p>No documents yet.</p> : (
                <div className="table-container">
                    <table className="table text-center">
                        <thead className="thead-dark">
                            <tr><th scope="col">Date</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col" aria-label="Open" /></tr>
                        </thead>
                        <tbody>
                            {documents.map(document => (
                                <tr key={document.id}>
                                    <td>{document.date}</td>
                                    <td>{document.name}</td>
                                    <td>{TYPE_LABELS[document.type] ?? document.type}</td>
                                    <td><a href={`/api/documents/${document.id}`} target="_blank" rel="noopener noreferrer">Open</a></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Fragment>
    );
};

const GainsReport = () => {
    const [year, setYear] = useState(thisYear);
    const [report, setReport] = useState<TaxReport | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const load = async () => {
            setReport(undefined);
            try {
                setReport((await axios.get<TaxReport | null>(`/api/tax/${year}`)).data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        load();
    }, [year]);

    if (error) return <p className="text-danger mt-3">Couldn&apos;t load the report: {error}</p>;
    if (report === undefined) return <p className="mt-3">Loading...</p>;
    if (report === null) return <p className="mt-3">Open an account first.</p>;
    const { totals, sales, federalWithheld } = report.form1099B;
    const unrealizedTotal = report.unrealized.reduce((sum, lot) => sum + (lot.unrealized ?? 0), 0);
    return (
        <Fragment>
            <div className="activity-toolbar mt-3">
                <label>
                    Tax year{" "}
                    <select className="form-control form-control-sm d-inline-block w-auto" value={year} onChange={e => setYear(Number(e.target.value))}>
                        {YEARS.map(option => <option key={option} value={option}>{option}</option>)}
                    </select>
                </label>
            </div>
            <dl className="margin-panel-grid mt-3">
                {[
                    ["Short-term gain or loss", signed(totals.short.gain)], ["Long-term gain or loss", signed(totals.long.gain)],
                    ["Wash sale losses disallowed", formatCurrency(totals.short.washDisallowed + totals.long.washDisallowed)],
                    ["Ordinary dividends", formatCurrency(report.form1099DIV.ordinaryDividends)], ["Interest income", formatCurrency(report.form1099INT.interestIncome)],
                    ["Federal tax withheld", formatCurrency(federalWithheld + report.form1099DIV.federalWithheld + report.form1099INT.federalWithheld)]
                ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            <h2 className="open-orders-title mt-4">Realized in {year}</h2>
            {sales.length === 0 ? <p>No sales in {year}.</p> : (
                <div className="table-container">
                    <table className="table table-sm text-center">
                        <thead className="thead-dark">
                            <tr>
                                <th scope="col">Sold</th><th scope="col">Shares</th><th scope="col">Acquired</th><th scope="col">Proceeds</th><th scope="col">Cost basis</th>
                                <th scope="col">Wash sale</th><th scope="col">Gain or loss</th><th scope="col">Term</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sales.map(sale => (
                                <tr key={sale.id}>
                                    <td>{day(sale.closedAt)}</td>
                                    <td>{formatShares(sale.qty)} {sale.symbol}{sale.side === "short" && <span className="fill-detail">short sale</span>}{sale.kind !== "sale" && <span className="fill-detail">{sale.kind.replaceAll("_", " ")}</span>}</td>
                                    <td>{day(sale.dateAcquired)}</td>
                                    <td>{formatCurrency(sale.proceeds)}</td>
                                    <td>{formatCurrency(sale.costBasis)}</td>
                                    <td>{sale.washDisallowed > 0 ? `${formatCurrency(sale.washDisallowed)} W` : "—"}</td>
                                    <td className={gainClass(sale.gain)}>{signed(sale.gain)}</td>
                                    <td>{sale.term === "long" ? "Long" : "Short"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="text-muted">
                Lots close first in, first out. W: a loss disallowed because the same stock was bought within 30 days before or after the sale; it&apos;s added to the replacement shares&apos; basis.
                Every dividend is reported as ordinary (qualified status isn&apos;t known). Simulated figures, not for filing.
            </p>
            <h2 className="open-orders-title mt-4">Unrealized</h2>
            {report.unrealized.length === 0 ? <p>No open lots.</p> : (
                <div className="table-container">
                    <table className="table table-sm text-center">
                        <thead className="thead-dark">
                            <tr>
                                <th scope="col">Shares</th><th scope="col">Acquired</th><th scope="col">Price</th><th scope="col">Tax basis</th><th scope="col">Market value</th>
                                <th scope="col">Unrealized</th><th scope="col">Term now</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.unrealized.map(lot => (
                                <tr key={lot.id}>
                                    <td>{formatShares(lot.qty)} {lot.symbol}{lot.side === "short" && <span className="fill-detail">short</span>}</td>
                                    <td>{day(lot.dateAcquired)}{lot.dateAcquired !== lot.acquiredAt && <span className="fill-detail">holding period carried over</span>}</td>
                                    <td>{formatPrice(lot.price)}</td>
                                    <td>{formatCurrency(lot.costBasis)}{lot.washAdjustment > 0 && <span className="fill-detail">includes {formatCurrency(lot.washAdjustment)} wash sale loss</span>}</td>
                                    <td>{lot.marketValue === null ? "—" : formatCurrency(lot.marketValue)}</td>
                                    <td className={gainClass(lot.unrealized)}>{lot.unrealized === null ? "—" : signed(lot.unrealized)}</td>
                                    <td>{lot.term === "long" ? "Long" : "Short"}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot><tr><td colSpan={5} className="text-right"><strong>Total</strong></td><td className={gainClass(unrealizedTotal)}>{signed(unrealizedTotal)}</td><td /></tr></tfoot>
                    </table>
                </div>
            )}
        </Fragment>
    );
};

export default DocumentsPage;
