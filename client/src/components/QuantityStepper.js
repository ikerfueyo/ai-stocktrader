import React, { useState } from "react";

// Decimal input with -/+ buttons that step by 1. decimals limits what can be typed (6 for shares, 2 for dollars).
const QuantityStepper = ({ value, setValue, max = Infinity, decimals = 6, prefix = "" }) => {
    // The text being typed, kept apart from value so partial input such as "0." or "" isn't overwritten
    const [draft, setDraft] = useState(null);
    const pattern = new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);
    const round = (n) => Number(n.toFixed(decimals));
    // Money shows cents; shares show only the decimals they have
    const formatted = decimals === 2 ? value.toFixed(2) : String(value);

    const onChange = (e) => {
        const text = e.target.value;
        if (!pattern.test(text)) return;
        const parsed = parseFloat(text) || 0;
        if (parsed > max) {
            setDraft(null);
            setValue(max);
            return;
        }
        setDraft(text);
        setValue(parsed);
    };

    const step = (delta) => {
        setDraft(null);
        setValue(Math.min(max, round(value + delta)));
    };

    return (
        <div className="quantity-container">
            <button type="button" onClick={() => step(-1)} disabled={value <= 1}>-</button>
            <span className="quantity-field">
                {prefix && <span className="quantity-prefix">{prefix}</span>}
                <input type="text" inputMode="decimal" className={`quantity-input ${prefix ? "has-prefix" : ""}`}
                    value={draft ?? formatted}
                    onChange={onChange}
                    onBlur={() => setDraft(null)}
                />
            </span>
            <button type="button" onClick={() => step(1)} disabled={value >= max}>+</button>
        </div>
    );
};

export default QuantityStepper;
