import React, { Fragment } from "react";
import { Link } from "react-router-dom";

const StockRanking = ({ title = "", stocks = [] }) => {
    return (
        <Fragment>
            <div className="ranking-container">
                <h1>{title}</h1>
                <table className="table table-dark">
                    <tbody>
                        {stocks.map((ticker, index) => (
                                <tr key={index}>
                                    <th scope="row">{index + 1}</th>
                                    <td>
                                        <Link to={`/trading/${ticker}`}>{ticker}</Link>
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </Fragment>
    )
};

export default StockRanking;
