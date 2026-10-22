"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatEastern } from "@/lib/marketHours";
import { describeOrderSize, describeOrderType } from "@/lib/orders";
import type { OrderRow } from "@/lib/types";

interface OpenOrdersProps {
    // Only this ticker's orders (the Trading page); all of them otherwise (the Portfolio page)
    ticker?: string;
    // Changing it reloads the list, such as after placing an order
    refreshKey?: number;
}

// The user's open orders, with a cancel button each. Renders nothing when there are none.
const OpenOrders = ({ ticker, refreshKey = 0 }: OpenOrdersProps) => {
    const [orders, setOrders] = useState<OrderRow[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState<number | null>(null);
    const [version, setVersion] = useState(0);
    const { refreshAccount } = useAccount();

    useEffect(() => {
        const getOrders = async () => {
            try {
                const response = await axios.get<OrderRow[]>(`/api/orders?status=open${ticker ? `&ticker=${encodeURIComponent(ticker.toUpperCase())}` : ""}`);
                setOrders(response.data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getOrders();
    }, [ticker, refreshKey, version]);

    const onCancel = async (id: number) => {
        setCancelling(id);
        try {
            await axios.delete(`/api/orders/${id}`);
            refreshAccount();
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        } finally {
            setCancelling(null);
            setVersion(v => v + 1);
        }
    };

    if (error) return <p className="text-danger">Couldn&apos;t load open orders: {error}</p>;
    if (orders.length === 0) return null;

    return (
        <div className="open-orders">
            <h2 className="open-orders-title">Open orders</h2>
            <table className="table table-sm text-center">
                <thead>
                    <tr>
                        {!ticker && <th scope="col">Ticker</th>}
                        <th scope="col">Side</th>
                        <th scope="col">Type</th>
                        <th scope="col">Size</th>
                        <th scope="col">Good for</th>
                        <th scope="col" aria-label="Cancel" />
                    </tr>
                </thead>
                <tbody>
                    {orders.map(order => (
                        <tr key={order.id}>
                            {!ticker && <td><Link href={`/trading/${order.ticker}`}>{order.ticker}</Link></td>}
                            <td className={order.side === "BUY" ? "text-success" : "text-danger"}><strong>{order.side}</strong></td>
                            <td>
                                {describeOrderType(order)}
                                {order.triggered_at && <span className="fill-detail">stop triggered</span>}
                            </td>
                            <td>{describeOrderSize(order)}</td>
                            <td>{order.time_in_force === "GTC" ? "Until cancelled" : order.expires_at ? `Until ${formatEastern(order.expires_at, { withDay: true })}` : "Day"}</td>
                            <td>
                                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => onCancel(order.id)} disabled={cancelling === order.id}>
                                    {cancelling === order.id ? "Cancelling…" : "Cancel"}
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default OpenOrders;
