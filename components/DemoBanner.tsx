// At the top of every page of a public demo (NEXT_PUBLIC_DEMO=true at build time): the brokerage is simulated, so visitors know not to
// enter real personal details
const DemoBanner = () => {
    if (process.env.NEXT_PUBLIC_DEMO !== "true") return null;
    return (
        <div className="demo-banner" role="note">
            <strong>Demo:</strong> a simulated brokerage with no real money. Don&apos;t enter real personal information; any well-formed
            made-up details work (such as SSN 123-45-6789). Market data is shown for demonstration only.
        </div>
    );
};

export default DemoBanner;
