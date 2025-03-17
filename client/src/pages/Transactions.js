import React, { Fragment } from "react";
import Header from "../components/Header";
import TransactionsList from "../components/TransactionsList";

function Transactions() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <TransactionsList />
            </div>
        </Fragment>
    );
};

export default Transactions;