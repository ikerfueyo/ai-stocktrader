"use client";

import { Fragment, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { logError } from "@/lib/apiError";
import type { SymbolMatch } from "@/lib/types";

// Ticker search with suggestions (GET /api/search, from the first character, 250ms after typing stops). Arrow keys move through the
// suggestions; Enter opens the highlighted one, or the typed ticker.
const TickerSearchBar = ({ className = "" }: { className?: string }) => {

    const [ticker, setTicker] = useState("");
    const [matches, setMatches] = useState<SymbolMatch[]>([]);
    const [highlighted, setHighlighted] = useState(-1);
    const [open, setOpen] = useState(false);
    const router = useRouter();
    const query = ticker.trim();

    useEffect(() => {
        if (!query) return;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const response = await axios.get<SymbolMatch[]>(`/api/search?q=${encodeURIComponent(query)}`);
                if (!cancelled) {
                    setMatches(response.data);
                    setHighlighted(-1);
                }
            } catch (error) {
                logError(error);
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);

    const go = (symbol: string) => {
        setOpen(false);
        setTicker("");
        setMatches([]);
        router.push(`/trading/${symbol}`);
    };

    const onSubmitForm = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (open && highlighted >= 0 && matches[highlighted]) {
            go(matches[highlighted].symbol);
        } else if (query) {
            go(query.toUpperCase());
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHighlighted(index => matches.length === 0 ? -1 : (index + step + matches.length) % matches.length);
        } else if (e.key === "Escape") {
            setOpen(false);
        }
    };

    const shown = open && query !== "" && matches.length > 0;

    return (
        <Fragment>
            <form className={`d-flex search-bar-container ${className}`} onSubmit={onSubmitForm} role="search">
                <div className="search-field">
                    <input type="text" className="form-control" placeholder="Search a ticker or company..."
                        value={ticker} onChange={e => { setTicker(e.target.value.toUpperCase()); setOpen(true); }}
                        onKeyDown={onKeyDown} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
                        role="combobox" aria-expanded={shown} aria-controls="ticker-suggestions" aria-autocomplete="list" />
                    {shown && (
                        <ul className="search-suggestions" id="ticker-suggestions" role="listbox">
                            {matches.map((match, index) => (
                                <li key={`${match.symbol}-${match.region}`} role="option" aria-selected={index === highlighted}
                                    className={index === highlighted ? "highlighted" : ""}
                                    onMouseDown={e => { e.preventDefault(); go(match.symbol); }}>
                                    <strong>{match.symbol}</strong> <span>{match.name}</span>
                                    {match.region !== "United States" && <span className="search-region">{match.region}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <button type="submit" className="btn btn-success">Search</button>
            </form>
        </Fragment>
    )
}

export default TickerSearchBar;
