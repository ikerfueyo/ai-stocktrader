import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";

const AIAnalysis = ({ ticker }) => {
    const [news, setNews] = useState([]);

    const getNews = async () => {
        try {
            const response = await axios.get(`http://localhost:5001/trading/news/${ticker}`);
            const filteredData = response.data.feed.map(item => ({
                title: item.title,
                summary: item.summary
            }));
            
            const limitedData = filteredData.slice(0, 250);
            setNews(limitedData);
        } catch (error) {
            console.error(error.message);
        }
    };

    const prompt = `Based on the news below, write a brief one-paragraph analysis on whether the user should buy or sell stock ${ticker}.`;
    const [analysis, setAnalysis] = useState([]);

    const getAnalysis = async () => {
        if (!news || news.length === 0) {
            console.log("Waiting for news data.");
            return;
        }

        try {
            const response = await axios.post("http://localhost:5001/gpt", {
                prompt: prompt,
                news: news
            });

            const analysisParagraph = response.data;
            setAnalysis(analysisParagraph);
        } catch (error) {
            console.error(error.message);
        }
    };


    useEffect(() => {
        getNews();
    }, []);
    
    useEffect(() => {
        getAnalysis();
    }, [news]);
    
    
    return (
        <Fragment>
            <div className="analysis-box">
                {analysis.length > 0 ? <p>{analysis}</p> : <p>Loading...</p>}
            </div>
        </Fragment>
    )
};

export default AIAnalysis;