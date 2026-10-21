import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import StockRanking from "../components/StockRanking";

const Rankings = () => {
    const [rankings, setRankings] = useState(null);
    const [error, setError] = useState(null);

    const getRankings = async () => {
        try {
            const response = await axios.get("/rankings");
            setRankings(response.data);
        } catch (error) {
            console.error(error.message);
            setError(error.response?.data?.error ?? error.message);
        }
    };

    useEffect(() => {
        getRankings();
    }, []);

    if (error) {
        return <p className="text-danger">Couldn't load rankings: {error}</p>;
    }

    return (
        <Fragment>
            <div className="rankings-container">
                <div>
                    {rankings ? <StockRanking title="Buy Top 5 by AI" stocks={rankings.buy} emptyText="No stocks have a buy verdict right now." /> : <p>Loading...</p>}
                </div>
                <div>
                    {rankings ? <StockRanking title="Sell Top 5 by AI" stocks={rankings.sell} emptyText="No stocks have a sell verdict right now." /> : <p>Loading...</p>}
                </div>
            </div>
        </Fragment>
    );

};

export default Rankings;
