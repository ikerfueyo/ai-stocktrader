// Plotly's prebuilt finance bundle (components/Plot.tsx), which has no types of its own
declare module "plotly.js/dist/plotly-finance.min.js" {
    const Plotly: object;
    export default Plotly;
}
