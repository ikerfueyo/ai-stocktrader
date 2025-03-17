import React, { Fragment, useEffect, useState } from "react";
import axios from "axios";
import BuyRanking from "../components/BuyRanking";
import SellRanking from "../components/SellRanking";

const Rankings = () => {
    const [news, setNews] = useState([]);

    const getNews = async () => {
        const cachedNews = localStorage.getItem("newsData");
        /*
        if (cachedNews.length > 0) {
            console.log("Using cached news data");
            setNews(JSON.parse(cachedNews));
            return;
        }
        */
        try {
            const response = await axios.get("http://localhost:5001/");
            const filteredData = response.data.feed.map(item => ({
                title: item.title,
                summary: item.summary
            }));
            
            const limitedData = filteredData.slice(0, 250);
            localStorage.setItem("newsData", JSON.stringify(limitedData));
            setNews(limitedData);
        } catch (error) {
            console.error(error.message);
        }
    };

    useEffect(() => {
        getNews();
    }, []);

    return (
        <Fragment>
            <div className="rankings-container">
                <div>
                    {news.length > 0 ? <BuyRanking news={news}/> : <p>Loading...</p>}
                </div>
                <div>
                    {news.length > 0 ? <SellRanking news={news}/> : <p>Loading...</p>}
                </div>
            </div>
        </Fragment>
    );
    
};

export default Rankings;