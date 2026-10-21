import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";

const VERDICT_LABELS = { BUY: "Buy", HOLD: "Hold", SELL: "Sell" };

const AIAnalysis = ({ ticker }) => {
    const [analysis, setAnalysis] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        const getAnalysis = async () => {
            setAnalysis(null);
            setError(null);
            try {
                const response = await axios.get(`/analysis/${ticker}`);
                setAnalysis(response.data);
            } catch (error) {
                console.error(error.message);
                setError(error.response?.data?.error ?? error.message);
            }
        };
        getAnalysis();
    }, [ticker]);

    return (
        <Fragment>
            <div className="analysis-box">
                {error ? <p className="text-danger">Couldn't load AI analysis: {error}</p>
                    : analysis ? (
                        <Fragment>
                            <p className="analysis-verdict">AI verdict: {VERDICT_LABELS[analysis.verdict]}</p>
                            <p>{analysis.analysis}</p>
                        </Fragment>
                    ) : <p>Loading...</p>}
            </div>
        </Fragment>
    )
};

export default AIAnalysis;
