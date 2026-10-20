import React, { Fragment, useState } from "react";
import { useNavigate} from "react-router-dom";

const TickerSearchBar = ({ className = "" }) => {

    const [ticker, setTicker] = useState("");
    const navigate = useNavigate();

    const onSubmitForm = async e => {
        e.preventDefault();
        if (!ticker.trim()) return;
        try {
            navigate(`/trading/${ticker.trim()}`);
        } catch (error) {
            console.error(error.message);
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