import { Fragment } from "react";
import TransferForm from "@/components/TransferForm";

export default function Withdraw() {
    return (
        <Fragment>
            <div>
                <TransferForm direction="withdraw" />
            </div>
        </Fragment>
    );
}
