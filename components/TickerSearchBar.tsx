"use client";

import { Fragment, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const TickerSearchBar = ({ className = "" }: { className?: string }) => {

    const [ticker, setTicker] = useState("");
    const router = useRouter();

    const onSubmitForm = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!ticker.trim()) return;
        try {
            router.push(`/trading/${ticker.trim()}`);
        } catch (error) {
            console.error(error instanceof Error ? error.message : error);
        }
    }

    return (
        <Fragment>
            <form className={`d-flex search-bar-container ${className}`} onSubmit={onSubmitForm}>
                <input type="text" className="form-control" placeholder="Enter a ticker symbol..."
                    value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} />
                <button type="submit" className="btn btn-success">Search</button>
            </form>
        </Fragment>
    )
}

export default TickerSearchBar;
