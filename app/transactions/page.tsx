import { Fragment } from "react";
import Header from "@/components/Header";
import TransactionsList, { type HistoryTab } from "@/components/TransactionsList";

const TABS: HistoryTab[] = ["orders", "trades", "cash"];

export default async function Transactions({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
    const { tab } = await searchParams;

    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <TransactionsList tab={TABS.find(id => id === tab) ?? "trades"} />
            </div>
        </Fragment>
    );
}
