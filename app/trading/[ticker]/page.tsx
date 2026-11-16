import { Fragment } from "react";
import TradingInterface from "@/components/TradingInterface";

export default async function Trading({ params }: { params: Promise<{ ticker: string }> }) {
    const { ticker } = await params;

    return (
        <Fragment>
            <div className="mt-5">
                <TradingInterface ticker={ticker} />
            </div>
        </Fragment>
    );
}
