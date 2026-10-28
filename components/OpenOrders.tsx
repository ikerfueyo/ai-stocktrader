"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import { accountActivityKey, useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { describeOrderSize, describeOrderType, formatPrice, formatShares, orderStatusLabel, orderSymbolLabel, TIME_IN_FORCE_LABELS } from "@/lib/orders";
import { contractName, isOptionSymbol, parseOptionSymbol } from "@/lib/options";
import type { AppOrder, BrokerOrder, BrokerOrderUpdate, OrderDetails } from "@/lib/types";

interface OpenOrdersProps {
    // Only this ticker's orders (the Trading page); all of them otherwise (the Portfolio page)
    ticker?: string;
    // Only the option orders (contracts and spreads) on this stock (the Trading page's options section)
    optionsOf?: string;
    // Changing it reloads the list, such as after placing an order
    refreshKey?: number;
}

type Leg = NonNullable<BrokerOrder["legs"]>[number];
type ListedOrder = AppOrder | (Leg & { leg: true });

// What a replace can change: whole shares, the limit, stop or trail, and the time in force (day or GTC)
interface Edit {
    id: string;
    qty: number;
    limitPrice: number;
    stopPrice: number;
    trail: number;
    timeInForce: "day" | "gtc";
}

const formatTime = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" });

// The stock an option order trades contracts of (an mleg order's legs'), or null for a stock order
const underlyingOf = (order: Pick<BrokerOrder, "symbol" | "order_class" | "legs">) =>
    parseOptionSymbol(order.order_class === "mleg" ? order.legs?.[0]?.symbol ?? "" : order.symbol ?? "")?.underlying ?? null;

// A notional or fractional order can't be replaced, nor one that has started filling, nor an mleg order or its legs
const replaceable = (order: ListedOrder) =>
    order.order_class !== "mleg" && order.notional === null && Number.isInteger(Number(order.qty)) && Number(order.filled_qty ?? 0) === 0 && ["new", "accepted", "held"].includes(order.status!);

// The user's open orders, with bracket, OCO and OTO legs under their entry: modify (a replace), cancel, cancel all, and the details of
// each (its timeline of fills and status changes). Renders nothing when there are none.
const OpenOrders = ({ ticker, optionsOf, refreshKey = 0 }: OpenOrdersProps) => {
    const [orders, setOrders] = useState<AppOrder[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [edit, setEdit] = useState<Edit | null>(null);
    const [details, setDetails] = useState<{ id: string; data: OrderDetails | null; error: string | null } | null>(null);
    const [version, setVersion] = useState(0);
    const { account, refreshAccount } = useAccount();
    // Reloads when a fill, expiry or buy-in changes the account, such as one by the broker's order engine
    const activity = accountActivityKey(account);

    useEffect(() => {
        const getOrders = async () => {
            try {
                const response = await axios.get<AppOrder[]>(`/api/orders?status=open${ticker ? `&symbols=${encodeURIComponent(ticker.toUpperCase())}` : ""}`);
                setOrders(optionsOf ? response.data.filter(order => underlyingOf(order) === optionsOf.toUpperCase()) : response.data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getOrders();
    }, [ticker, optionsOf, refreshKey, version, activity]);

    const run = async (id: string, action: () => Promise<unknown>) => {
        setBusy(id);
        setError(null);
        try {
            await action();
            refreshAccount();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setBusy(null);
            setVersion(v => v + 1);
        }
    };

    const onCancel = (id: string) => run(id, () => axios.delete(`/api/orders/${id}`));
    const onCancelAll = () => run("all", () => axios.delete("/api/orders"));

    const onEdit = (order: ListedOrder) => setEdit({
        id: order.id!, qty: Number(order.qty), limitPrice: Number(order.limit_price ?? 0), stopPrice: Number(order.stop_price ?? 0),
        trail: Number(order.trail_percent ?? order.trail_price ?? 0), timeInForce: order.time_in_force === "gtc" ? "gtc" : "day"
    });

    const onSave = (order: ListedOrder) => run(order.id!, async () => {
        if (!edit) return;
        const update: BrokerOrderUpdate = {
            qty: String(edit.qty),
            ...(order.type === "limit" || order.type === "stop_limit" ? { limit_price: String(edit.limitPrice) } : {}),
            ...(order.type === "stop" || order.type === "stop_limit" ? { stop_price: String(edit.stopPrice) } : {}),
            ...(order.type === "trailing_stop" ? { trail: String(edit.trail) } : {}),
            ...(order.time_in_force === "day" || order.time_in_force === "gtc" ? { time_in_force: edit.timeInForce } : {})
        };
        await axios.patch(`/api/orders/${order.id}`, update);
        setEdit(null);
    });

    const onDetails = async (id: string) => {
        if (details?.id === id) {
            setDetails(null);
            return;
        }
        setDetails({ id, data: null, error: null });
        try {
            const { data } = await axios.get<OrderDetails>(`/api/orders/${id}`);
            setDetails({ id, data, error: null });
        } catch (error) {
            logError(error);
            setDetails({ id, data: null, error: apiErrorMessage(error) });
        }
    };

    if (orders.length === 0) return error ? <p className="text-danger">Couldn&apos;t load open orders: {error}</p> : null;

    const listed: ListedOrder[] = orders.flatMap(order => [order, ...(order.legs ?? []).map(leg => ({ ...leg, leg: true as const }))]);
    // The contract column shows on the Portfolio page and in the options section; the Trading page's own orders are its ticker's
    const showSymbol = !ticker;
    const columns = showSymbol ? 8 : 7;

    return (
        <div className="open-orders">
            <div className="open-orders-header">
                <h2 className="open-orders-title">{optionsOf ? "Open option orders" : "Open orders"}</h2>
                {orders.length > 1 && (
                    <button type="button" className="btn btn-sm btn-outline-danger" onClick={onCancelAll} disabled={busy !== null}>
                        {busy === "all" ? "Cancelling…" : "Cancel all"}
                    </button>
                )}
            </div>
            {error && <p className="text-danger">{error}</p>}
            <table className="table table-sm text-center">
                <thead>
                    <tr>
                        {showSymbol && <th scope="col">{optionsOf ? "Contract" : "Ticker"}</th>}
                        <th scope="col">Side</th>
                        <th scope="col">Type</th>
                        <th scope="col">Size</th>
                        <th scope="col">Good for</th>
                        <th scope="col">Status</th>
                        <th scope="col" aria-label="Details" />
                        <th scope="col" aria-label="Actions" />
                    </tr>
                </thead>
                <tbody>
                    {listed.map(order => {
                        const leg = "leg" in order;
                        const editing = edit?.id === order.id;
                        const filled = Number(order.filled_qty ?? 0);
                        return (
                            <Fragment key={order.id}>
                                <tr className={leg ? "order-leg" : undefined}>
                                    {showSymbol && <td>{leg ? (isOptionSymbol(order.symbol ?? "") ? <span className="order-leg-name">↳ {contractName(order.symbol!)}</span> : "↳") : <Link href={`/trading/${parseOptionSymbol(order.symbol ?? "")?.underlying ?? (order.order_class === "mleg" ? parseOptionSymbol(order.legs?.[0]?.symbol ?? "")?.underlying : order.symbol)}`}>{orderSymbolLabel(order)}</Link>}</td>}
                                    <td className={order.side === "buy" ? "text-success" : "text-danger"}><strong>{leg && ticker ? "↳ " : ""}{order.side?.toUpperCase()}</strong></td>
                                    <td>
                                        {describeOrderType(order)}
                                        {order.order_class === "mleg" ? (leg ? <span className="fill-detail">ratio {(order as Leg & { ratio_qty?: string }).ratio_qty ?? 1}</span> : <span className="fill-detail">{order.legs?.length ?? 0} legs</span>)
                                            : order.order_class && order.order_class !== "simple" && <span className="fill-detail">{leg ? order.group_role?.replace("_", " ") : `${order.order_class.toUpperCase()} ${order.group_role === "entry" ? "entry" : order.group_role?.replace("_", " ") ?? ""}`}</span>}
                                    </td>
                                    <td>
                                        {describeOrderSize(order)}
                                        {filled > 0 && <span className="fill-detail">{formatShares(filled)} filled @ {formatPrice(order.filled_avg_price!)}</span>}
                                    </td>
                                    <td>
                                        {TIME_IN_FORCE_LABELS[order.time_in_force!]}
                                        {order.extended_hours && <span className="fill-detail">extended hours</span>}
                                    </td>
                                    <td>{orderStatusLabel(order.status!)}</td>
                                    <td>
                                        <button type="button" className="btn btn-sm btn-link" onClick={() => onDetails(order.id!)}>{details?.id === order.id ? "Hide" : "Details"}</button>
                                    </td>
                                    <td className="order-actions">
                                        {replaceable(order) && !editing && (
                                            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onEdit(order)} disabled={busy !== null}>Modify</button>
                                        )}
                                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => onCancel(order.id!)} disabled={busy !== null}>
                                            {busy === order.id ? "…" : "Cancel"}
                                        </button>
                                    </td>
                                </tr>
                                {editing && edit && (
                                    <tr className="order-edit">
                                        <td colSpan={columns}>
                                            <div className="order-entry">
                                                <label>{isOptionSymbol(order.symbol ?? "") ? "Contracts" : "Shares"} <QuantityStepper value={edit.qty} setValue={qty => setEdit({ ...edit, qty })} decimals={0} /></label>
                                                {(order.type === "stop" || order.type === "stop_limit") && <label>Stop <QuantityStepper value={edit.stopPrice} setValue={stopPrice => setEdit({ ...edit, stopPrice })} decimals={2} prefix="$" /></label>}
                                                {(order.type === "limit" || order.type === "stop_limit") && <label>Limit <QuantityStepper value={edit.limitPrice} setValue={limitPrice => setEdit({ ...edit, limitPrice })} decimals={2} prefix="$" /></label>}
                                                {order.type === "trailing_stop" && <label>Trail <QuantityStepper value={edit.trail} setValue={trail => setEdit({ ...edit, trail })} decimals={2} prefix={order.trail_price ? "$" : ""} />{order.trail_percent ? "%" : ""}</label>}
                                                {(order.time_in_force === "day" || order.time_in_force === "gtc") && (
                                                    <label>
                                                        Good for
                                                        <select className="form-control form-control-sm" value={edit.timeInForce} onChange={e => setEdit({ ...edit, timeInForce: e.target.value as Edit["timeInForce"] })}>
                                                            <option value="day">Day</option>
                                                            <option value="gtc">Until cancelled</option>
                                                        </select>
                                                    </label>
                                                )}
                                                <button type="button" className="btn btn-sm btn-primary" onClick={() => onSave(order)} disabled={busy !== null || !(edit.qty >= 1)}>Save</button>
                                                <button type="button" className="btn btn-sm btn-link" onClick={() => setEdit(null)}>Back</button>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {details?.id === order.id && (
                                    <tr className="order-details">
                                        <td colSpan={columns}>
                                            {details.error ? <span className="text-danger">{details.error}</span> : !details.data ? "Loading…" : <OrderTimeline details={details.data} />}
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

// An order's timeline, oldest first: submitted, each fill, and how it ended, with when it expires while it's open
const OrderTimeline = ({ details: { order, fills } }: { details: OrderDetails }) => {
    const events: { at: string; text: string }[] = [{ at: order.submitted_at ?? order.created_at!, text: `Submitted${order.replaces ? ` (replacing order ${order.replaces.slice(0, 8)})` : ""}` }];
    for (const fill of [...fills].reverse()) {
        events.push({ at: fill.date, text: `${fill.type === "BUY" ? "Bought" : "Sold"} ${formatShares(fill.quantity)} at ${formatPrice(fill.price)}${fill.settle_date ? `, settles ${fill.settle_date}` : ""}` });
    }
    if (order.canceled_at) events.push({ at: order.canceled_at, text: `Cancelled${order.reason ? `: ${order.reason}` : ""}` });
    if (order.expired_at) events.push({ at: order.expired_at, text: `Expired${order.reason ? `: ${order.reason}` : ""}` });
    if (order.filled_at) events.push({ at: order.filled_at, text: `Filled: ${formatShares(order.filled_qty!)} at an average ${formatPrice(order.filled_avg_price!)}` });
    events.sort((a, b) => a.at.localeCompare(b.at));
    return (
        <ol className="order-timeline">
            {events.map(({ at, text }, index) => <li key={index}><span className="text-muted">{formatTime(at)}</span> {text}</li>)}
            {order.hwm && <li className="text-muted">High-water mark {formatPrice(order.hwm)}</li>}
            <li className="text-muted">Order {order.id.slice(0, 8)} · client ID {order.client_order_id?.slice(0, 8)} · {order.order_class === "simple" ? "simple" : order.order_class} order{order.status === "accepted" ? ", waiting for its session" : ""}</li>
        </ol>
    );
};

export default OpenOrders;
