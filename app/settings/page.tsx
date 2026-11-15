import { Fragment } from "react";
import Header from "@/components/Header";
import AccountSettings from "@/components/AccountSettings";

export default function Settings() {
    return (
        <Fragment>
            <Header />
            <div>
                <AccountSettings />
            </div>
        </Fragment>
    );
}
