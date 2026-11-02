import { Fragment } from "react";
import Header from "@/components/Header";
import TransferForm from "@/components/TransferForm";

export default function Deposit() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <TransferForm direction="deposit" />
            </div>
        </Fragment>
    );
}
