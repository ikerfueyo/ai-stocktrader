import { formatEastern, type MarketStatus } from "@/lib/marketHours";

const SESSION_LABELS = { "pre-market": "pre-market", "after-hours": "after hours" } as const;

// "Market open · closes 4:00 PM ET", "Market closed · after hours until 8:00 PM ET · opens Thu 9:30 AM ET" or
// "Market closed · opens Mon 9:30 AM ET"
const MarketStatusBadge = ({ status }: { status: MarketStatus | null }) => {
    if (!status) return null;
    // nextClose is null while open only when MARKET_HOURS_OVERRIDE forces it open outside the session
    const { session, extendedClose } = status;
    const extended = (session === "pre-market" || session === "after-hours") && extendedClose
        ? `${SESSION_LABELS[session]} until ${formatEastern(extendedClose)}`
        : null;
    const detail = status.open
        ? status.nextClose && `closes ${formatEastern(status.nextClose)}${status.earlyClose ? " (early close)" : ""}`
        : [extended, `opens ${formatEastern(status.nextOpen, { withDay: true })}`].filter(Boolean).join(" · ");
    return (
        <p className={`market-status ${status.open ? "open" : status.extendedOpen ? "extended" : "closed"}`}>
            <span className="market-status-dot" aria-hidden="true" />
            Market {status.open ? "open" : "closed"}{detail && ` · ${detail}`}
        </p>
    );
};

export default MarketStatusBadge;
