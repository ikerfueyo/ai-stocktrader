import React, { Fragment } from "react";
import { useParams } from "react-router-dom";
import Header from "../components/Header";
import TradingInterface from "../components/TradingInterface";

function Trading() {
    const { ticker } = useParams();

    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div className="mt-5">
                <TradingInterface ticker={ticker} />
            </div>
        </Fragment>
    );
};

export default Trading;