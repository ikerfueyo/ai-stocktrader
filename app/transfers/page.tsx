import { Fragment } from "react";
import Header from "@/components/Header";
import TransfersPage from "@/components/TransfersPage";

export default function Transfers() {
    return (
        <Fragment>
            <Header />
            <div>
                <TransfersPage />
            </div>
        </Fragment>
    );
}
