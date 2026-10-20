import React, { Fragment } from "react";
import Plot from "react-plotly.js";

const CandlestickChart = ({ data = null }) => {
    if (!data || Object.keys(data).length === 0) {
        return <p>Loading chart data...</p>;
    }

    const dates = Object.keys(data).sort((a, b) => b.localeCompare(a));
    const openPrices = dates.map(date => parseFloat(data[date]["1. open"]));
    const highPrices = dates.map(date => parseFloat(data[date]["2. high"]));
    const lowPrices = dates.map(date => parseFloat(data[date]["3. low"]));
    const closePrices = dates.map(date => parseFloat(data[date]["4. close"]));

    return (
        <Fragment>
            <div>
                <Plot
                    data={[
                        {
                            x: dates,
                            open: openPrices,
                            high: highPrices,
                            low: lowPrices,
                            close: closePrices,
                            type: "candlestick",
                            xaxis: "x",
                            yaxis: "y",
                        },
                    ]}
                    layout={{
                        title: "Stock Price Candlestick Chart",
                        xaxis: { title: "Date", rangeslider: { visible: false } },
                        yaxis: { title: "Price (USD)" },
                    }}
                    style={{ width: "100%", height: "500px" }}
                />
            </div>
        </Fragment>
    )
};

export default CandlestickChart;