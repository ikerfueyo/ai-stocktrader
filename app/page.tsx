import { Fragment } from "react";
import Header from "@/components/Header";
import Rankings from "@/components/Rankings";
import Watchlist from "@/components/Watchlist";

export default function Home() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <Watchlist />
                <Rankings />
            </div>
        </Fragment>
    );
}
