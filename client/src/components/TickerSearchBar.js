import React, { Fragment, useState } from "react";
import { useNavigate} from "react-router-dom";

const TickerSearchBar = () => {

    const [ticker, setTicker] = useState("");
    const navigate = useNavigate();

    const onSubmitForm = async e => {
        e.preventDefault();
        try {
            navigate(`/trading/${ticker}`);
        } catch (error) {
            console.error(error.message);
        }
    }

    return (
        <Fragment>
            <form className="d-flex mt-5 search-bar-container" onSubmit={onSubmitForm}>
                <input type="text" className="form-control" placeholder="Enter a ticker symbol..."
                    value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} />
                <button type="submit" className="btn btn-success">Search</button>
            </form>
        </Fragment>
    )
}

export default TickerSearchBar;