"use client";

import dynamic from "next/dynamic";

// The charts' Plotly component. Plotly needs the browser's window, so it only renders on the client. It's built from Plotly's finance
// bundle (scatter, bar and candlestick traces, the ones the charts use; 1.2 MB) rather than react-plotly.js's default full bundle
// (11 MB), which made every page with a chart slow to compile and load.
const Plot = dynamic(async () => {
    const [{ default: createPlotlyComponent }, { default: Plotly }] = await Promise.all([
        import("react-plotly.js/factory"),
        import("plotly.js/dist/plotly-finance.min.js")
    ]);
    return createPlotlyComponent(Plotly);
}, { ssr: false, loading: () => <p>Loading chart...</p> });

export default Plot;
