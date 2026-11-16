import Link from "next/link";

// One side of the home page's AI rankings: a card with a green (buy) or red (sell) accent and the tickers in order
const StockRanking = ({ title = "", side, stocks = [], emptyText = "" }: { title?: string; side: "buy" | "sell"; stocks?: string[]; emptyText?: string }) => {
    return (
        <section className={`ranking-container ${side}`}>
            <div className="ranking-header">
                <span className="ranking-side" aria-hidden="true">{side === "buy" ? "↑" : "↓"}</span>
                <h2>{title}</h2>
            </div>
            {stocks.length > 0 && (
                <ol className="ranking-list">
                    {stocks.map((ticker, index) => (
                        <li key={ticker}>
                            <Link href={`/trading/${ticker}`}>
                                <span className="ranking-rank">{index + 1}</span>
                                {ticker}
                                <span className="ranking-arrow" aria-hidden="true">→</span>
                            </Link>
                        </li>
                    ))}
                </ol>
            )}
            {stocks.length === 0 && <p className="ranking-empty">{emptyText}</p>}
        </section>
    );
};

export default StockRanking;
