"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import StockRanking from "./StockRanking";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { Rankings as RankingsData } from "@/lib/types";

const Rankings = () => {
    const [rankings, setRankings] = useState<RankingsData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getRankings = async () => {
            try {
                const response = await axios.get<RankingsData>("/api/rankings");
                setRankings(response.data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getRankings();
    }, []);

    if (error) {
        return <p className="text-danger">Couldn&apos;t load rankings: {error}</p>;
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
