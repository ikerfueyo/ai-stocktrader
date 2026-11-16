import { Fragment } from "react";
import TransactionsList, { type HistoryTab } from "@/components/TransactionsList";

const TABS: HistoryTab[] = ["orders", "trades", "cash", "activity"];

export default async function Transactions({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
    const { tab } = await searchParams;

    return (
        <Fragment>
            <div>
                <TransactionsList tab={TABS.find(id => id === tab) ?? "trades"} />
            </div>
        </Fragment>
    );
}
