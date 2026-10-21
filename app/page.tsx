import { Fragment } from "react";
import Header from "@/components/Header";
import Rankings from "@/components/Rankings";

export default function Home() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <Rankings />
            </div>
        </Fragment>
    );
}
