"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import AnalysisDetailsView from "./AnalysisDetailsView";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { TickerAnalysis, TickerVerdict } from "@/lib/types";

const VERDICT_LABELS: Record<TickerVerdict, string> = { BUY: "Buy", HOLD: "Hold", SELL: "Sell" };

const AIAnalysis = ({ ticker }: { ticker: string }) => {
    const [analysis, setAnalysis] = useState<TickerAnalysis | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const getAnalysis = async () => {
            setAnalysis(null);
            setError(null);
            try {
                const response = await axios.get<TickerAnalysis>(`/api/analysis/${ticker}`);
                setAnalysis(response.data);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        getAnalysis();
    }, [ticker]);

    return (
        <Fragment>
            <div className="analysis-box">
                {error ? <p className="text-danger">Couldn&apos;t load AI analysis: {error}</p>
                    : analysis ? <AnalysisDetailsView verdictLabel={VERDICT_LABELS[analysis.verdict]} thesis={analysis.analysis} details={analysis} />
                    : <p>Loading...</p>}
            </div>
        </Fragment>
    )
};

export default AIAnalysis;
