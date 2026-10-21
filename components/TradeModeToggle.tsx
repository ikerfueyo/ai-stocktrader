import type { TradeMode } from "@/lib/orders";

// Switches order entry between a number of shares and a dollar amount
const TradeModeToggle = ({ mode, setMode, disabled = false }: { mode: TradeMode; setMode: (mode: TradeMode) => void; disabled?: boolean }) => {
    return (
        <div className="trade-mode-toggle" role="group" aria-label="Order in">
            <button type="button" className={mode === "shares" ? "active" : ""} aria-pressed={mode === "shares"}
                onClick={() => setMode("shares")} disabled={disabled}>Shares</button>
            <button type="button" className={mode === "dollars" ? "active" : ""} aria-pressed={mode === "dollars"}
                onClick={() => setMode("dollars")} disabled={disabled}>$</button>
        </div>
    );
};

export default TradeModeToggle;
