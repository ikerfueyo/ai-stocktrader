import { Fragment } from "react";
import NotificationsCenter, { type NotificationsTab } from "@/components/NotificationsCenter";

const TABS: NotificationsTab[] = ["notifications", "alerts", "recurring", "drip", "preferences"];

export default async function Notifications({ searchParams }: { searchParams: Promise<{ tab?: string; symbol?: string }> }) {
    const { tab, symbol } = await searchParams;

    return (
        <Fragment>
            <div>
                <NotificationsCenter tab={TABS.find(id => id === tab) ?? "notifications"} symbol={symbol?.toUpperCase() ?? ""} />
            </div>
        </Fragment>
    );
}
