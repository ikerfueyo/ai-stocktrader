import React, { Fragment, useEffect, useState } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import { Link } from "react-router-dom";

const SellRanking = (props) => {
    const prompt = "Based on the news below, create a ranking of the top 5 stocks to sell in the following format (no output other than that specified by the format): 1. [Number 1 stock symbol] 2. [Number 2 stock symbol] 3. [Number 3 stock symbol] 4. [Number 4 stock symbol] 5. [Number 5 stock symbol]";
    const [stocks, setStocks] = useState([]);
    
    const getStocks = async () => {
        if (!props.news || props.news.length === 0) {
            console.log("No news data provided.");
            return;
        }

        try {
            const response = await axios.post("http://localhost:5001/gpt", {
                prompt: prompt,
                news: props.news
            });

            const stockList = response.data.split("\n").map((line) => {
                const parts = line.split(". "); // Split "1. AAPL" into ["1", "AAPL"]
                return parts.length === 2 ? { ticker: parts[1] } : null;
            }).filter(Boolean);

            setStocks(stockList);
        } catch (error) {
            console.error(error.message);
        }
    };

    useEffect(() => {
        getStocks();
    }, []);

    return (
        <Fragment>
            <div className="ranking-container">
                <h1>Sell Top 5 by AI</h1>
                <table className="table table-dark">
                    <tbody>
                        {stocks.map((stock, index) => (
                                <tr key={index}>
                                    <th scope="row">{index + 1}</th>
                                    <td>
                                        <Link to={`/trading/${stock.ticker}`}>{stock.ticker}</Link>
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    )
};

SellRanking.propTypes = {
    news: PropTypes.arrayOf(
        PropTypes.shape({
            title: PropTypes.string,
            summary: PropTypes.string
        })
    )
};

SellRanking.defaultProps = {
    news: []
};

export default SellRanking;