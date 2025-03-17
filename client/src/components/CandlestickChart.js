import React, { Fragment } from "react";
import PropTypes from "prop-types";
import Plot from "react-plotly.js";

const CandlestickChart = (props) => {
    if (!props.data || Object.keys(props.data).length === 0) {
        return <p>Loading chart data...</p>;
    }

    const dates = Object.keys(props.data).sort((a, b) => b.localeCompare(a));
    const openPrices = dates.map(date => parseFloat(props.data[date]["1. open"]));
    const highPrices = dates.map(date => parseFloat(props.data[date]["2. high"]));
    const lowPrices = dates.map(date => parseFloat(props.data[date]["3. low"]));
    const closePrices = dates.map(date => parseFloat(props.data[date]["4. close"]));

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

CandlestickChart.propTypes = {
    data: PropTypes.objectOf(
        PropTypes.shape({
            "1. open": PropTypes.string,
            "2. high": PropTypes.string,
            "3. low": PropTypes.string,
            "4. close": PropTypes.string,
            "5. volume": PropTypes.string
        })
    )
};

CandlestickChart.defaultProps = {
    data: null
};

export default CandlestickChart;