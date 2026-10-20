import React, { Fragment } from "react";
import Header from "../components/Header";
import Rankings from "../components/Rankings";

function Home() {
    return (
        <Fragment>
            <div>
                <Header />
            </div>
            <div>
                <Rankings />
            </div>
        </Fragment>
    );
};

export default Home;