# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AI StockTrader is a mock-trading web app: a Create React App frontend (`client/`) and an Express backend (`server/`) backed by PostgreSQL. Stock prices and news come from Alpha Vantage; buy/sell rankings and per-ticker analysis come from OpenAI (`gpt-4o`) sentiment analysis of news titles/summaries.

## Commands

From the repo root:

- `npm run install-all`: install `client/` and `server/` dependencies
- `npm start`: run client (port 3000) and server (port 5001, via `node --watch`) together with `concurrently`

Per package:

- Client: `npm start --prefix client`, `npm run build --prefix client`, `npm test --prefix client` (Jest via react-scripts; single test: `npm test --prefix client -- -t "<name>"` or pass a file path). There are currently no test files.
- Server: `npm start --prefix server` (`node --watch`, restarts on changes to `index.js` and the modules it requires) or `node server/index.js`.
- Linting is CRA's built-in ESLint (`react-app` config), which runs during `npm start`/`build`. There is no standalone lint script.

## Setup

`server/.env` (gitignored) needs `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `ALPHA_VANTAGE_API_KEY`, `OPENAI_API_KEY`, and optionally `ALPHA_VANTAGE_ENTITLEMENT`. The schema is in `server/db.sql`: a single `transactions` table (`date` as `TIMESTAMPTZ`, `type` = `BUY`/`SELL`, `ticker`, `price`, `quantity`, `total`). `quantity` is `NUMERIC(18, 6)` for fractional shares, which `pg` returns as a string, so parse it before doing math. Schema changes for existing databases go in `server/migrations/` as numbered `.sql` files, applied by hand with `psql -U postgres -d ai_stocktrader -f <file>`.

## Architecture

**Server** (`server/index.js`, all routes in one file; `server/db.js` exports a `pg` Pool):
- `GET /rankings`: fetches market news, makes one OpenAI call in JSON mode, and returns `{ buy: [...5 tickers], sell: [...5 tickers] }` (validated and uppercased by `toTickers`)
- `GET /analysis/:ticker`: fetches ticker news (dots become hyphens, since the news endpoint expects `BRK-A` where prices use `BRK.A`) and returns `{ analysis }`, a one-paragraph buy/sell take
- `GET /trading/:ticker`: Alpha Vantage `TIME_SERIES_DAILY` (full history), passed through as is. It sends `entitlement=ALPHA_VANTAGE_ENTITLEMENT` (default `delayed`), because even premium keys get only end-of-day data without it. With the entitlement, the newest bar is today's partial day, and its close is the price shown and traded. A key without that entitlement gets a `Note` back. Alpha Vantage replies with an empty `{}` both for unknown symbols and during its own price-data outages, and the two can't be told apart.
- `POST /trading/:ticker`: body `{ transaction: {...} }`, inserts into `transactions`
- `GET /transactions`: all rows, newest first (`id` breaks ties for rows migrated from the old `DATE` column, which all sit at midnight)
- `GET /portfolio`: open positions `[{ ticker, quantity, avgCost, price, error }]`, computed from `transactions` by `computePositions` (no positions table). `quantity` is signed: Trading-page sells past zero are intentional shorts, so a negative position is a short. Cost basis is average cost: adding to a position re-averages it, reducing it keeps the average, and a trade that flips the side opens the remainder at the trade price. Quantities are rounded to 6 decimals after each trade (`roundShares`), so float drift can't leave a tiny position open. Prices come from `TIME_SERIES_DAILY` (`compact`, same entitlement and newest-bar close as `/trading/:ticker`), fetched in parallel with `Promise.allSettled`, so a ticker whose price fails gets `price: null` and an `error` instead of failing the whole response.
- `GET /portfolio/:ticker/analysis`: `{ analysis }`, a hold-or-sell take for longs, or keep-short-or-cover for shorts (the server picks the prompt from the position; 404 if there's no open position)

All AI prompts live on the server (`/rankings`, `/analysis/:ticker`). There's deliberately no generic prompt endpoint, so the OpenAI key can't be used as an open proxy. Shared helpers: `fetchAlphaVantage`, `fetchNews` (first 250 `{title, summary}`) and `fetchTickerNews` (hyphenated symbol, 404 when empty), `analyzeNews` (system prompt plus OpenAI call), and `sendError`.

Error contract: every route's `catch` calls `sendError`, which logs `METHOD url: message` and always returns `{ error: message }` with one of these statuses:
- 502: a bad reply from Alpha Vantage, OpenAI, or the model. Alpha Vantage reports rate limits, missing entitlements and bad symbols with HTTP 200 and a `Note`/`Information`/`Error Message` body (or `{}`), so `fetchAlphaVantage` throws an `UpstreamError` whenever the expected key is missing. OpenAI SDK errors also map to 502.
- 404: `/analysis/:ticker` and `/portfolio/:ticker/analysis` when the ticker has no news, or the latter when there's no open position (`UpstreamError` with an explicit status).
- 504: an upstream call timed out. Alpha Vantage times out at 30s (its response times vary widely), OpenAI at 30s with 1 retry, and the Postgres connection at 5s (in `db.js`).
- 500: anything else, such as database errors.

**Client** (React 19, react-router v7; routes in `client/src/App.js`: `/`, `/trading/:ticker`, `/transactions`, `/portfolio`):
- API calls use axios with relative paths (`/rankings`, `/trading/${ticker}`, …). The CRA dev server proxies them to `localhost:5001` via the `"proxy"` field in `client/package.json`. Don't hardcode the backend URL, and use axios rather than `fetch` so non-2xx responses throw.
- Each fetching component keeps an `error` state and shows `error.response?.data?.error ?? error.message` in place of its loading text.
- Home → `Rankings` calls `/rankings` and renders two presentational `StockRanking` tables. Trading → `TradingInterface` loads the time series (price, `BuySellFunctionality`, `CandlestickChart`), and `AIAnalysis` loads `/analysis/:ticker` independently.
- Portfolio → `PortfolioList` loads `/portfolio` and renders a `PortfolioRow` per position. Each row closes the position (SELL for longs, BUY to cover shorts) through `POST /trading/:ticker`, then updates its quantity locally instead of refetching every price. The round AI button calls `/portfolio/:ticker/analysis` only on first open and caches the result. `QuantityStepper` is shared with `BuySellFunctionality`.
- Fractional orders: both trade forms have a `TradeModeToggle` (Shares | $) and an editable decimal `QuantityStepper` (6 decimals for shares, 2 for dollars). `toOrder` in `client/src/utils/orders.js` turns the input into `{ quantity, total }`: a dollar amount becomes `amount / price` shares, and on the portfolio an amount that covers the whole position closes it exactly.
- No prop-types and no `defaultProps`. React 19 ignores both on function components, so put defaults in the destructured parameters. Parameter defaults don't apply to `null`.

**Styling:** Bootstrap 4.6 is loaded from a CDN in `client/public/index.html`, plus custom classes in `client/src/App.css`. Tailwind v3 is also active, picked up automatically by CRA from `client/tailwind.config.js`; CRA 5 doesn't support Tailwind v4 or custom `postcss.config.js`. Preflight is disabled so Bootstrap keeps its base styles. Class names shared by both libraries (`mt-5`, `py-4`, `mr-2`, `shadow-lg`) resolve to Tailwind's values, because the bundled CSS loads after the CDN link.

## Repo notes

- Each home page load costs 1 Alpha Vantage call plus 1 OpenAI call, each trading page load costs 2 Alpha Vantage calls plus 1 OpenAI call, each portfolio page load costs 1 Alpha Vantage call per open position, and each portfolio AI button costs 1 Alpha Vantage call plus 1 OpenAI call the first time it's opened. Nothing is cached, so this counts against the Alpha Vantage plan's rate limit (the free tier allows about 25 requests a day).
