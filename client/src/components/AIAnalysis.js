import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";

const AIAnalysis = ({ ticker }) => {
    const [analysis, setAnalysis] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        const getAnalysis = async () => {
            setAnalysis(null);
            setError(null);
            try {
                const response = await axios.get(`/analysis/${ticker}`);
                setAnalysis(response.data.analysis);
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
                    : analysis ? <p>{analysis}</p> : <p>Loading...</p>}
            </div>
        </Fragment>
    )
};

export default AIAnalysis;
