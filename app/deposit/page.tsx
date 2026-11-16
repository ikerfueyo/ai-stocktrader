import { Fragment } from "react";
import TransferForm from "@/components/TransferForm";

export default function Deposit() {
    return (
        <Fragment>
            <div>
                <TransferForm direction="deposit" />
            </div>
        </Fragment>
    );
}
