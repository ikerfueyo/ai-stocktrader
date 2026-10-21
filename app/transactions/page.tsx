import { Fragment } from "react";
import Header from "@/components/Header";
import TransactionsList from "@/components/TransactionsList";

export default function Transactions() {
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
}
