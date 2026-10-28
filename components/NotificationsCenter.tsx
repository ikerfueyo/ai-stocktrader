"use client";

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, formatPrice } from "@/lib/orders";
import { ALERT_LABELS, describeAlert, FREQUENCY_LABELS, type AlertCondition, type Frequency } from "@/lib/automation";
import { KIND_LABELS, NOTIFICATION_KINDS } from "@/lib/server/notificationRules";
import { timeAgo } from "./NotificationBell";
import type { DripSettings, NotificationItem, NotificationPreferences, NotificationsResponse, PriceAlert, RecurringInvestment } from "@/lib/types";

export type NotificationsTab = "notifications" | "alerts" | "recurring" | "drip" | "preferences";

const TAB_LABELS: [NotificationsTab, string][] = [
    ["notifications", "Notifications"], ["alerts", "Price alerts"], ["recurring", "Recurring buys"], ["drip", "Dividend reinvestment"], ["preferences", "Preferences"]
];
const easternToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// What a tab loads, reloaded after each change
const useLoad = <T,>(url: string) => {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const load = async () => {
            try {
                setData((await axios.get<T>(url)).data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        load();
    }, [url, version]);
    const reload = useCallback(() => setVersion(current => current + 1), []);
    return { data, error, reload, setData };
};

// The browser's notification permission (default while rendering on the server), updated after asking for it
const permissionListeners = new Set<() => void>();
const subscribePermission = (listener: () => void) => {
    permissionListeners.add(listener);
    return () => {
        permissionListeners.delete(listener);
    };
};
const readPermission = (): NotificationPermission | "unsupported" => typeof Notification === "undefined" ? "unsupported" : Notification.permission;

// The notifications center: every notification, price alerts, recurring buys, dividend reinvestment and the preferences for each kind
// of notification (in the app, and in the browser). Tabs kept in the URL as ?tab=; ?symbol= fills in the alert and recurring forms.
const NotificationsCenter = ({ tab = "notifications", symbol = "" }: { tab?: NotificationsTab; symbol?: string }) => (
    <div className="notifications-page">
        <ul className="nav nav-tabs history-tabs mt-5">
            {TAB_LABELS.map(([id, label]) => (
                <li className="nav-item" key={id}>
                    <Link href={`/notifications?tab=${id}${symbol && (id === "alerts" || id === "recurring") ? `&symbol=${symbol}` : ""}`} className={`nav-link ${tab === id ? "active" : ""}`}
                        aria-current={tab === id ? "page" : undefined}>{label}</Link>
                </li>
            ))}
        </ul>
        <div className="notifications-body">
            {tab === "notifications" && <NotificationList />}
            {tab === "alerts" && <Alerts symbol={symbol} />}
            {tab === "recurring" && <Recurring symbol={symbol} />}
            {tab === "drip" && <Reinvestment />}
            {tab === "preferences" && <Preferences />}
        </div>
    </div>
);

const NotificationList = () => {
    const router = useRouter();
    const { data, error, reload } = useLoad<NotificationsResponse>("/api/notifications?limit=200");
    const markRead = async (ids?: number[]) => {
        try {
            await axios.post("/api/notifications/read", ids ? { ids } : {});
            reload();
        } catch (error) {
            logError(error);
        }
    };
    const open = (item: NotificationItem) => {
        if (!item.read) markRead([item.id]);
        if (!item.link) return;
        if (item.link.startsWith("/api/")) window.open(item.link, "_blank", "noopener,noreferrer");
        else router.push(item.link);
    };
    if (error) return <p className="text-danger">{error}</p>;
    if (!data) return <p>Loading...</p>;
    return (
        <Fragment>
            <div className="notifications-toolbar">
                <span>{data.unread} unread</span>
                <button type="button" className="btn btn-outline-secondary btn-sm" disabled={data.unread === 0} onClick={() => markRead()}>Mark all read</button>
            </div>
            {data.items.length === 0 ? (
                <p className="text-muted">No notifications yet. Fills, cancellations, transfers, dividends, margin calls, corporate actions, new documents and your price alerts show up here.</p>
            ) : (
                <ul className="list-group notification-list">
                    {data.items.map(item => (
                        <li key={item.id} className={`list-group-item ${item.read ? "" : "unread"}`}>
                            <button type="button" className="notification-row" onClick={() => open(item)}>
                                <span className="notification-kind">{KIND_LABELS[item.kind]?.split(":")[0]}</span>
                                <span className="bell-item-title">{item.title}</span>
                                {item.body && <span className="bell-item-body">{item.body}</span>}
                                <span className="bell-item-time" title={new Date(item.createdAt).toLocaleString()}>{timeAgo(item.createdAt)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Fragment>
    );
};

const Alerts = ({ symbol }: { symbol: string }) => {
    const { data, error, reload } = useLoad<{ alerts: PriceAlert[] }>("/api/alerts");
    const [form, setForm] = useState({ symbol, condition: "above" as AlertCondition, threshold: "", rearm: false });
    const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
    const [saving, setSaving] = useState(false);
    const percent = form.condition === "change_up" || form.condition === "change_down";

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        try {
            const { alert } = (await axios.post<{ alert: PriceAlert }>("/api/alerts", { alert: { ...form, threshold: Number(form.threshold) } })).data;
            setMessage({ text: `Alert set: ${describeAlert(alert.symbol, alert.condition, alert.threshold)}`, ok: true });
            setForm({ ...form, threshold: "" });
            reload();
        } catch (error) {
            setMessage({ text: apiErrorMessage(error), ok: false });
        } finally {
            setSaving(false);
        }
    };
    const remove = async (id: string) => {
        try {
            await axios.delete(`/api/alerts/${id}`);
            reload();
        } catch (error) {
            setMessage({ text: apiErrorMessage(error), ok: false });
        }
    };

    return (
        <Fragment>
            <form className="automation-form" onSubmit={submit}>
                <input className="form-control" placeholder="Ticker" aria-label="Ticker" value={form.symbol} onChange={event => setForm({ ...form, symbol: event.target.value.toUpperCase() })} required />
                <select className="form-control" aria-label="Condition" value={form.condition} onChange={event => setForm({ ...form, condition: event.target.value as AlertCondition })}>
                    {(Object.keys(ALERT_LABELS) as AlertCondition[]).map(condition => <option key={condition} value={condition}>{ALERT_LABELS[condition]}</option>)}
                </select>
                <div className="input-group">
                    {!percent && <div className="input-group-prepend"><span className="input-group-text">$</span></div>}
                    <input className="form-control" type="number" min="0.0001" step="any" placeholder={percent ? "5" : "100.00"} aria-label={percent ? "Percent" : "Price"}
                        value={form.threshold} onChange={event => setForm({ ...form, threshold: event.target.value })} required />
                    {percent && <div className="input-group-append"><span className="input-group-text">%</span></div>}
                </div>
                <label className="automation-check">
                    <input type="checkbox" checked={form.rearm} onChange={event => setForm({ ...form, rearm: event.target.checked })} /> Keep it on after it fires
                </label>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Setting..." : "Set alert"}</button>
            </form>
            <p className="text-muted small">Checked against the latest quote every 30 seconds during market hours. A price alert fires when the price crosses the level; a daily move alert once a day.</p>
            {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
            {error ? <p className="text-danger">{error}</p> : !data ? <p>Loading...</p> : data.alerts.length === 0 ? <p className="text-muted">No alerts.</p> : (
                <table className="table table-sm automation-table">
                    <thead><tr><th>Alert</th><th>Status</th><th>Last checked price</th><th>Fired</th><th /></tr></thead>
                    <tbody>
                        {data.alerts.map(alert => (
                            <tr key={alert.id}>
                                <td><Link href={`/trading/${alert.symbol}`}>{describeAlert(alert.symbol, alert.condition, alert.threshold)}</Link>{alert.rearm && <span className="badge badge-light ml-2">stays on</span>}</td>
                                <td>{alert.status === "active" ? "Watching" : "Fired"}</td>
                                <td>{alert.lastPrice === null ? "—" : formatPrice(alert.lastPrice)}</td>
                                <td>{alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleString() : "—"}</td>
                                <td><button type="button" className="btn btn-link btn-sm text-danger p-0" onClick={() => remove(alert.id)}>Delete</button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Fragment>
    );
};

const Recurring = ({ symbol }: { symbol: string }) => {
    const { data, error, reload } = useLoad<{ recurring: RecurringInvestment[] }>("/api/recurring");
    const [form, setForm] = useState({ symbol, amount: "25", frequency: "weekly" as Frequency, startDate: easternToday() });
    const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
    const [saving, setSaving] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        try {
            const { recurring } = (await axios.post<{ recurring: RecurringInvestment }>("/api/recurring", { recurring: { ...form, amount: Number(form.amount) } })).data;
            setMessage({ text: `${formatCurrency(recurring.amount)} of ${recurring.symbol} ${FREQUENCY_LABELS[recurring.frequency].toLowerCase()}, first on ${longDate(recurring.nextRunDate)}`, ok: true });
            reload();
        } catch (error) {
            setMessage({ text: apiErrorMessage(error), ok: false });
        } finally {
            setSaving(false);
        }
    };
    const change = async (id: string, request: Promise<unknown>) => {
        try {
            await request;
            reload();
        } catch (error) {
            setMessage({ text: apiErrorMessage(error), ok: false });
        }
        return id;
    };

    return (
        <Fragment>
            <form className="automation-form" onSubmit={submit}>
                <input className="form-control" placeholder="Ticker" aria-label="Ticker" value={form.symbol} onChange={event => setForm({ ...form, symbol: event.target.value.toUpperCase() })} required />
                <div className="input-group">
                    <div className="input-group-prepend"><span className="input-group-text">$</span></div>
                    <input className="form-control" type="number" min="1" step="0.01" aria-label="Amount" value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} required />
                </div>
                <select className="form-control" aria-label="How often" value={form.frequency} onChange={event => setForm({ ...form, frequency: event.target.value as Frequency })}>
                    {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map(frequency => <option key={frequency} value={frequency}>{FREQUENCY_LABELS[frequency]}</option>)}
                </select>
                <input className="form-control" type="date" aria-label="Starting" min={easternToday()} value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} required />
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Start recurring buy"}</button>
            </form>
            <p className="text-muted small">
                Each date buys the amount as a market order at the open (the next trading day when the market&apos;s closed), in fractional shares. If the account doesn&apos;t have the buying power, the
                recurring buy pauses and you&apos;re notified.
            </p>
            {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
            {error ? <p className="text-danger">{error}</p> : !data ? <p>Loading...</p> : data.recurring.length === 0 ? <p className="text-muted">No recurring buys.</p> : (
                <table className="table table-sm automation-table">
                    <thead><tr><th>Stock</th><th>Amount</th><th>How often</th><th>Next</th><th>Last bought</th><th>Status</th><th /></tr></thead>
                    <tbody>
                        {data.recurring.map(plan => (
                            <tr key={plan.id}>
                                <td><Link href={`/trading/${plan.symbol}`}>{plan.symbol}</Link></td>
                                <td>{formatCurrency(plan.amount)}</td>
                                <td>{FREQUENCY_LABELS[plan.frequency]}</td>
                                <td>{plan.status === "active" ? longDate(plan.nextRunDate) : "—"}</td>
                                <td>{plan.lastRunDate ? longDate(plan.lastRunDate) : "—"}</td>
                                <td>{plan.status === "active" ? "Active" : <span className="text-warning" title={plan.pauseReason ?? ""}>Paused{plan.pauseReason ? `: ${plan.pauseReason}` : ""}</span>}</td>
                                <td className="text-nowrap">
                                    <button type="button" className="btn btn-link btn-sm p-0 mr-2"
                                        onClick={() => change(plan.id, axios.patch(`/api/recurring/${plan.id}`, { status: plan.status === "active" ? "paused" : "active" }))}>
                                        {plan.status === "active" ? "Pause" : "Resume"}
                                    </button>
                                    <button type="button" className="btn btn-link btn-sm text-danger p-0" onClick={() => change(plan.id, axios.delete(`/api/recurring/${plan.id}`))}>Delete</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Fragment>
    );
};

const OUTCOME_LABELS = { ordered: "Reinvested", held: "Held (under $1)", skipped: "Not reinvested", failed: "Order refused" };

const Reinvestment = () => {
    const { data, error, setData } = useLoad<DripSettings>("/api/drip");
    const [saveError, setSaveError] = useState<string | null>(null);
    const save = async (body: { symbol?: string; enabled: boolean | null }) => {
        try {
            setData((await axios.put<DripSettings>("/api/drip", body)).data);
            setSaveError(null);
        } catch (error) {
            setSaveError(apiErrorMessage(error));
        }
    };
    if (error) return <p className="text-danger">{error}</p>;
    if (!data) return <p>Loading...</p>;
    return (
        <Fragment>
            <label className="automation-check drip-default">
                <input type="checkbox" checked={data.enabled} onChange={event => save({ enabled: event.target.checked })} />
                <span><strong>Reinvest dividends</strong> on every position by default</span>
            </label>
            <p className="text-muted small">
                Each cash dividend buys more of the same stock with what was paid (less any backup withholding), as a market order in fractional shares. Amounts under $1 are held and added to
                the stock&apos;s next dividend. Stocks that can&apos;t be bought in fractions are paid in cash.
            </p>
            {saveError && <p className="text-danger">{saveError}</p>}
            {data.positions.length > 0 && (
                <table className="table table-sm automation-table">
                    <thead><tr><th>Position</th><th>Reinvest</th></tr></thead>
                    <tbody>
                        {data.positions.map(position => (
                            <tr key={position.symbol}>
                                <td><Link href={`/trading/${position.symbol}`}>{position.symbol}</Link></td>
                                <td>
                                    {position.fractionable ? (
                                        <select className="form-control form-control-sm drip-select" aria-label={`Reinvest ${position.symbol} dividends`}
                                            value={position.enabled === null ? "default" : position.enabled ? "on" : "off"}
                                            onChange={event => save({ symbol: position.symbol, enabled: event.target.value === "default" ? null : event.target.value === "on" })}>
                                            <option value="default">Account default ({data.enabled ? "on" : "off"})</option>
                                            <option value="on">On</option>
                                            <option value="off">Off</option>
                                        </select>
                                    ) : <span className="text-muted">Paid in cash (not fractionable)</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {data.pending.length > 0 && (
                <p>Held until they reach $1: {data.pending.map(({ symbol, amount }) => `${symbol} ${formatCurrency(amount)}`).join(", ")}</p>
            )}
            {data.recent.length > 0 && (
                <Fragment>
                    <h6 className="mt-4">Recent dividends</h6>
                    <table className="table table-sm automation-table">
                        <thead><tr><th>Date</th><th>Stock</th><th>Net amount</th><th>Outcome</th></tr></thead>
                        <tbody>
                            {data.recent.map((entry, index) => (
                                <tr key={index}>
                                    <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                                    <td>{entry.symbol}</td>
                                    <td>{formatCurrency(entry.amount)}</td>
                                    <td title={entry.note ?? ""}>{OUTCOME_LABELS[entry.outcome]}{entry.note ? <span className="fill-detail">{entry.note}</span> : null}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Fragment>
            )}
        </Fragment>
    );
};

const Preferences = () => {
    const { data, error, setData } = useLoad<{ preferences: NotificationPreferences }>("/api/notifications/preferences");
    const permission = useSyncExternalStore(subscribePermission, readPermission, () => "default" as const);
    const [saveError, setSaveError] = useState<string | null>(null);

    const save = async (preferences: Partial<NotificationPreferences>) => {
        try {
            setData((await axios.put<{ preferences: NotificationPreferences }>("/api/notifications/preferences", { preferences })).data);
            setSaveError(null);
        } catch (error) {
            setSaveError(apiErrorMessage(error));
        }
    };
    const allow = async () => {
        await Notification.requestPermission();
        permissionListeners.forEach(listener => listener());
    };

    if (error) return <p className="text-danger">{error}</p>;
    if (!data) return <p>Loading...</p>;
    return (
        <Fragment>
            <div className="browser-permission">
                {permission === "granted" ? <span className="text-success">This browser shows notifications for the kinds checked below while the app is open.</span>
                    : permission === "denied" ? <span className="text-muted">Notifications are blocked for this site in the browser&apos;s settings.</span>
                        : permission === "unsupported" ? <span className="text-muted">This browser doesn&apos;t support notifications.</span>
                            : <Fragment><span>Browser notifications are off.</span> <button type="button" className="btn btn-outline-primary btn-sm ml-2" onClick={allow}>Allow browser notifications</button></Fragment>}
            </div>
            {saveError && <p className="text-danger">{saveError}</p>}
            <table className="table table-sm automation-table preferences-table">
                <thead><tr><th>Notify me about</th><th>In the app</th><th>In the browser</th></tr></thead>
                <tbody>
                    {NOTIFICATION_KINDS.map(kind => {
                        const preference = data.preferences[kind];
                        return (
                            <tr key={kind}>
                                <td>{KIND_LABELS[kind]}</td>
                                <td><input type="checkbox" aria-label={`${KIND_LABELS[kind]} in the app`} checked={preference.inApp} onChange={event => save({ [kind]: { inApp: event.target.checked, browser: event.target.checked && preference.browser } })} /></td>
                                <td><input type="checkbox" aria-label={`${KIND_LABELS[kind]} in the browser`} checked={preference.browser} disabled={!preference.inApp || permission !== "granted"}
                                    onChange={event => save({ [kind]: { inApp: preference.inApp, browser: event.target.checked } })} /></td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className="text-muted small">Email notifications come with the hosted version. Regulatory fees and the steps of a transfer don&apos;t notify; what you do yourself (placing or cancelling an order, requesting a transfer) shows where you did it.</p>
        </Fragment>
    );
};

export default NotificationsCenter;
