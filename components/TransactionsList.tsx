"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { describeOrderSize, describeOrderType, formatCurrency, formatPrice, formatShares } from "@/lib/orders";
import type { CashActivityRow, CashActivityType, FillPolicy, OrderRow, OrderStatus, TransactionRow } from "@/lib/types";

export type HistoryTab = "orders" | "trades" | "cash";

const TABS: { tab: HistoryTab; label: string }[] = [{ tab: "orders", label: "Orders" }, { tab: "trades", label: "Trades" }, { tab: "cash", label: "Cash Activity" }];

const STATUS_CLASSES: Record<OrderStatus, string> = { OPEN: "text-primary", FILLED: "text-success", CANCELLED: "text-muted", EXPIRED: "text-muted", REJECTED: "text-danger" };

const FILL_LABELS: Record<FillPolicy, string> = { ASK: "at ask", BID: "at bid", SIM_ASK: "at ask (simulated)", SIM_BID: "at bid (simulated)", LAST: "at last price" };
const CASH_LABELS: Record<CashActivityType, string> = { DEPOSIT: "Deposit", WITHDRAW: "Withdrawal", DIVIDEND_IN: "Dividend received", DIVIDEND_OUT: "Dividend paid (short)" };
const isCredit = (type: CashActivityType) => type === "DEPOSIT" || type === "DIVIDEND_IN";

const formatDate = (date: string) => new Date(date).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });

// The account's history in tabs (kept in the URL as ?tab=): orders (limit, stop and queued orders, in every status), executed
// trades, and cash activity (deposits, withdrawals, dividends)
const TransactionsList = ({ tab = "trades" }: { tab?: HistoryTab }) => {
    // All newest first
    const [orders, setOrders] = useState<OrderRow[] | null>(null);
    const [trades, setTrades] = useState<TransactionRow[] | null>(null);
    const [cash, setCash] = useState<CashActivityRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getHistory = async () => {
            try {
                const [ordersResponse, tradesResponse, cashResponse] = await Promise.all([
                    axios.get<OrderRow[]>("/api/orders?status=all"), axios.get<TransactionRow[]>("/api/transactions"), axios.get<CashActivityRow[]>("/api/transfers")
                ]);
                setOrders(ordersResponse.data);
                setTrades(tradesResponse.data);
                setCash(cashResponse.data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getHistory();
    }, []);

    return (
        <Fragment>
            <ul className="nav nav-tabs history-tabs mt-5">
                {TABS.map(({ tab: id, label }) => (
                    <li className="nav-item" key={id}>
                        <Link href={`/transactions?tab=${id}`} className={`nav-link ${tab === id ? "active" : ""}`} aria-current={tab === id ? "page" : undefined}>{label}</Link>
                    </li>
                ))}
            </ul>
            {error ? (
                <p className="text-danger mt-3">Couldn&apos;t load your history: {error}</p>
            ) : orders === null || trades === null || cash === null ? (
                <p className="mt-3">Loading...</p>
            ) : tab === "orders" ? (
                orders.length === 0 ? <p className="mt-3">No orders yet. Limit, stop and stop-limit orders, and market orders placed while the market is closed, show up here.</p> : (
                    <div className="table-container mt-3">
                        <table className="table text-center">
                            <thead className="thead-dark">
                                <tr>
                                    <th scope="col">Placed</th>
                                    <th scope="col">Ticker</th>
                                    <th scope="col">Side</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Size</th>
                                    <th scope="col">Good for</th>
                                    <th scope="col">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map(order => (
                                    <tr key={order.id}>
                                        <td>{formatDate(order.created_at)}</td>
                                        <td><Link href={`/trading/${order.ticker}`}>{order.ticker}</Link></td>
                                        <td style={{ color: order.side === "BUY" ? "green" : "red", fontWeight: "bold" }}>{order.side}</td>
                                        <td>{describeOrderType(order)}</td>
                                        <td>{describeOrderSize(order)}</td>
                                        <td>{order.time_in_force === "GTC" ? "Until cancelled" : "Day"}</td>
                                        <td className={STATUS_CLASSES[order.status]}>
                                            <strong>{order.status.charAt(0) + order.status.slice(1).toLowerCase()}</strong>
                                            {order.status !== "OPEN" && <span className="fill-detail">{formatDate(order.updated_at)}</span>}
                                            {order.status_reason && order.status !== "CANCELLED" && <span className="fill-detail">{order.status_reason}</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            ) : tab === "trades" ? (
                trades.length === 0 ? <p className="mt-3">No trades yet.</p> : (
                    <div className="table-container mt-3">
                        <table className="table text-center">
                            <thead className="thead-dark">
                                <tr>
                                    <th scope="col">Date</th>
                                    <th scope="col">Ticker</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Price</th>
                                    <th scope="col">Quantity</th>
                                    <th scope="col">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {trades.map(trade => (
                                    <tr key={trade.id}>
                                        <td>{formatDate(trade.date)}</td>
                                        <td><Link href={`/trading/${trade.ticker}`}>{trade.ticker}</Link></td>
                                        <td style={{ color: trade.type === "BUY" ? "green" : "red", fontWeight: "bold" }}>
                                            {trade.type}
                                            {trade.reason === "LIQUIDATION" && (
                                                <span className="liquidation-tag" title="Automatic buy-in to restore short collateral">
                                                    {trade.type === "BUY" ? "buy-in" : "liquidation"}
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            {formatPrice(trade.price)}
                                            {trade.fill_policy && (
                                                <span className="fill-detail" title={trade.quote_time ? `Quote as of ${formatDate(trade.quote_time)}` : undefined}>
                                                    {FILL_LABELS[trade.fill_policy]}{trade.order_id !== null && ` · order #${trade.order_id}`}
                                                </span>
                                            )}
                                        </td>
                                        <td>{formatShares(trade.quantity)}</td>
                                        <td>{formatCurrency(trade.total)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            ) : (
                cash.length === 0 ? <p className="mt-3">No cash activity yet.</p> : (
                    <div className="table-container mt-3">
                        <table className="table text-center">
                            <thead className="thead-dark">
                                <tr>
                                    <th scope="col">Date</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Details</th>
                                    <th scope="col">Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cash.map(entry => (
                                    <tr key={entry.id}>
                                        <td>{formatDate(entry.date)}</td>
                                        <td style={{ color: isCredit(entry.type) ? "green" : "red", fontWeight: "bold" }}>{CASH_LABELS[entry.type]}</td>
                                        <td>{entry.method}{entry.reference && <span className="fill-detail">ex-date {entry.reference}</span>}</td>
                                        <td className={`price-change ${isCredit(entry.type) ? "positive" : "negative"}`}>
                                            {isCredit(entry.type) ? "+" : "-"}{formatCurrency(entry.amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            )}
        </Fragment>
    )
};

export default TransactionsList;
