import { Fragment } from "react";
import Rankings from "@/components/Rankings";
import Watchlist from "@/components/Watchlist";
import MarketMovers from "@/components/MarketMovers";

export default function Home() {
    return (
        <Fragment>
            <div>
                <Watchlist />
                <MarketMovers />
                <Rankings />
            </div>
        </Fragment>
    );
}
