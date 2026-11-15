import { Fragment } from "react";
import Header from "@/components/Header";
import PortfolioList from "@/components/PortfolioList";

export default function Portfolio() {
    return (
        <Fragment>
            <Header />
            <div>
                <PortfolioList />
            </div>
        </Fragment>
    );
}
