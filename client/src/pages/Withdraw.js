import React, { Fragment } from "react";
import Header from "../components/Header";
import TransferForm from "../components/TransferForm";

function Withdraw() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <TransferForm direction="withdraw" />
            </div>
        </Fragment>
    );
};

export default Withdraw;
