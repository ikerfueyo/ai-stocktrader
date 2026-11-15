// The Plotly charts' look, matching the tokens in app/globals.css (Plotly needs the colors themselves, not CSS variables)
export const CHART_COLORS = {
    gain: "#1e9e4a",
    loss: "#d63c4a",
    teal: "#00a5a8",
    benchmark: "#868e96",
    text: "#495057",
    grid: "#eef1f4",
    axis: "#dee2e6"
};

const axis = {
    gridcolor: CHART_COLORS.grid,
    linecolor: CHART_COLORS.axis,
    zerolinecolor: CHART_COLORS.axis,
    tickfont: { size: 11, color: CHART_COLORS.text }
};

export const CHART_LAYOUT = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", size: 12, color: CHART_COLORS.text },
    hoverlabel: { bgcolor: "#343a40", bordercolor: "#343a40", font: { color: "#ffffff", family: "Inter, -apple-system, sans-serif", size: 12 } },
    xaxis: axis,
    yaxis: axis
};
