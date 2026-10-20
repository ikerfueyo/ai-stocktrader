import React, { Fragment } from "react";
import Header from "../components/Header";
import PortfolioList from "../components/PortfolioList";

function Portfolio() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <PortfolioList />
            </div>
        </Fragment>
    );
};

export default Portfolio;
