import { Fragment } from "react";
import Header from "@/components/Header";
import TransfersPage from "@/components/TransfersPage";

export default function Transfers() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <TransfersPage />
            </div>
        </Fragment>
    );
}
