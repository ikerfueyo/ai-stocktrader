import { formatEastern, type MarketStatus } from "@/lib/marketHours";

// "Market open · closes 4:00 PM ET" or "Market closed · opens Mon 9:30 AM ET"
const MarketStatusBadge = ({ status }: { status: MarketStatus | null }) => {
    if (!status) return null;
    // nextClose is null while open only when MARKET_HOURS_OVERRIDE forces it open outside the session
    const detail = status.open
        ? status.nextClose && `closes ${formatEastern(status.nextClose)}${status.earlyClose ? " (early close)" : ""}`
        : `opens ${formatEastern(status.nextOpen, { withDay: true })}`;
    return (
        <p className={`market-status ${status.open ? "open" : "closed"}`}>
            <span className="market-status-dot" aria-hidden="true" />
            Market {status.open ? "open" : "closed"}{detail && ` · ${detail}`}
        </p>
    );
};

export default MarketStatusBadge;
