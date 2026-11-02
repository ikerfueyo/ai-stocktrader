"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { logError } from "@/lib/apiError";

// A star button that adds the ticker to the watchlist or removes it
const WatchlistStar = ({ ticker }: { ticker: string }) => {
    const [watched, setWatched] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        axios.get<{ watched: boolean }>(`/api/watchlist/${ticker}`).then(response => setWatched(response.data.watched), logError);
    }, [ticker]);

    const onToggle = async () => {
        setSaving(true);
        try {
            const response = watched
                ? await axios.delete<{ watched: boolean }>(`/api/watchlist/${ticker}`)
                : await axios.post<{ watched: boolean }>("/api/watchlist", { ticker });
            setWatched(response.data.watched);
        } catch (error) {
            logError(error);
        } finally {
            setSaving(false);
        }
    };

    if (watched === null) return null;
    return (
        <button type="button" className={`watchlist-star ${watched ? "watched" : ""}`} onClick={onToggle} disabled={saving}
            aria-pressed={watched} title={watched ? `Remove ${ticker} from your watchlist` : `Add ${ticker} to your watchlist`}>
            {watched ? "★" : "☆"}
        </button>
    );
};

export default WatchlistStar;
