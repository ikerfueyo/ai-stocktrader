"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import axios from "axios";
import { logError } from "@/lib/apiError";
import type { NotificationItem, NotificationsResponse } from "@/lib/types";

const POLL_MS = 30000;

export const timeAgo = (iso: string) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// The header's bell: the unread count and the latest notifications (GET /api/notifications every 30s while the page is visible, and
// when it becomes visible again). New ones of the kinds the user chose show as browser notifications when the browser allows them.
const NotificationBell = () => {
    const router = useRouter();
    const [data, setData] = useState<NotificationsResponse | null>(null);
    const [open, setOpen] = useState(false);
    const newest = useRef<number | null>(null);
    const container = useRef<HTMLSpanElement>(null);

    const load = useCallback(async () => {
        try {
            const response = (await axios.get<NotificationsResponse>("/api/notifications?limit=15")).data;
            // Only those that arrive after the first load are shown by the browser
            if (newest.current !== null && typeof Notification !== "undefined" && Notification.permission === "granted") {
                for (const item of response.items.filter(entry => entry.id > newest.current! && !entry.read && response.preferences[entry.kind]?.browser).reverse()) {
                    const shown = new Notification(item.title, { body: item.body, tag: `notification-${item.id}` });
                    shown.onclick = () => {
                        window.focus();
                        if (item.link) router.push(item.link);
                    };
                }
            }
            newest.current = Math.max(newest.current ?? 0, ...response.items.map(({ id }) => id));
            setData(response);
        } catch (error) {
            logError(error);
        }
    }, [router]);

    useEffect(() => {
        load();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") load();
        }, POLL_MS);
        const onVisible = () => {
            if (document.visibilityState === "visible") load();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [load]);

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent) => {
            if (!container.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);

    const markRead = async (ids?: number[]) => {
        try {
            await axios.post("/api/notifications/read", ids ? { ids } : {});
            await load();
        } catch (error) {
            logError(error);
        }
    };

    const openItem = (item: NotificationItem) => {
        setOpen(false);
        if (!item.read) markRead([item.id]);
        if (item.link) {
            // Documents open as pages of their own
            if (item.link.startsWith("/api/")) window.open(item.link, "_blank", "noopener,noreferrer");
            else router.push(item.link);
        }
    };

    const unread = data?.unread ?? 0;
    return (
        <span className="notification-bell mr-3" ref={container}>
            <button type="button" className="bell-button" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} onClick={() => setOpen(!open)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {unread > 0 && <span className="bell-badge">{unread > 99 ? "99+" : unread}</span>}
            </button>
            {open && (
                <div className="bell-menu shadow-lg" role="menu">
                    <div className="bell-menu-header">
                        <strong>Notifications</strong>
                        {unread > 0 && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => markRead()}>Mark all read</button>}
                    </div>
                    {data === null ? (
                        <p className="bell-empty">Loading...</p>
                    ) : data.items.length === 0 ? (
                        <p className="bell-empty">Nothing yet. Fills, transfers, dividends and your alerts show up here.</p>
                    ) : (
                        <ul className="bell-list">
                            {data.items.map(item => (
                                <li key={item.id}>
                                    <button type="button" role="menuitem" className={`bell-item ${item.read ? "" : "unread"}`} onClick={() => openItem(item)}>
                                        <span className="bell-item-title">{item.title}</span>
                                        {item.body && <span className="bell-item-body">{item.body}</span>}
                                        <span className="bell-item-time">{timeAgo(item.createdAt)}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="bell-menu-footer">
                        <Link href="/notifications" onClick={() => setOpen(false)}>All notifications</Link>
                        <Link href="/notifications?tab=preferences" onClick={() => setOpen(false)}>Preferences</Link>
                    </div>
                </div>
            )}
        </span>
    );
};

export default NotificationBell;
