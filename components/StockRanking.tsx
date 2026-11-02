import { Fragment } from "react";
import Link from "next/link";

const StockRanking = ({ title = "", stocks = [], emptyText = "" }: { title?: string; stocks?: string[]; emptyText?: string }) => {
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
                                        <Link href={`/trading/${ticker}`}>{ticker}</Link>
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
                {stocks.length === 0 && <p className="ranking-empty">{emptyText}</p>}
            </div>
        </Fragment>
    )
};

export default StockRanking;
