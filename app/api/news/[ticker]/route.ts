import { NextResponse } from "next/server";
import { withUser, type TickerContext } from "@/lib/server/errors";
import { fetchTickerNews, mainTickers, parseNewsTime } from "@/lib/server/marketData";
import type { TickerNewsItem } from "@/lib/types";

const MAX_ARTICLES = 15;

// Get the latest articles mainly about a ticker (it's among their most relevant tickers, mainTickers, so roundups and other
// companies' news that mention it are left out), newest first, with Alpha Vantage's sentiment and relevance for it (NEWS_SENTIMENT;
// an empty list when there's none)
export const GET = withUser(async (request, { params }: TickerContext) => {
    const ticker = (await params).ticker.toUpperCase();
    const symbol = ticker.replaceAll(".", "-");
    const news = (await fetchTickerNews(ticker).catch(error => {
        if (error.status === 404) return [];
        throw error;
    })).filter(item => mainTickers(item).some(({ ticker: tagged }) => tagged === symbol));
    return NextResponse.json<TickerNewsItem[]>(news.slice(0, MAX_ARTICLES).map(({ title, url, summary, published, tickers }) => {
        const scores = tickers.find(({ ticker: tagged }) => tagged === symbol)!;
        return { title, url, summary, published: parseNewsTime(published), sentiment: scores.sentiment, relevance: scores.relevance };
    }));
});
