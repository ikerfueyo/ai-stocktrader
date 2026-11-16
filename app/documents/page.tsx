import { Fragment } from "react";
import DocumentsPage, { type DocumentsTab } from "@/components/DocumentsPage";

const TABS: DocumentsTab[] = ["documents", "gains"];

export default async function Documents({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
    const { tab } = await searchParams;

    return (
        <Fragment>
            <div>
                <DocumentsPage tab={TABS.find(id => id === tab) ?? "documents"} />
            </div>
        </Fragment>
    );
}
