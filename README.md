# AI StockTrader

AI StockTrader is a full-stack web application for mock-trading U.S. common stocks (about 6,000 listings on NYSE, Nasdaq and the other U.S. exchanges) with **AI-driven insights**. It runs a simulated brokerage modeled on Alpaca's Broker API: you open an account, fund it with simulated transfers, and trade at realtime prices (with an Alpha Vantage premium plan that includes realtime U.S. market data). No real money moves and no real trades are placed.

## Features

- **Stock Symbol Search**: Look up any U.S. stock and see its realtime price, chart, earnings, company overview, news and an AI analysis.
- **AI-Powered Buy/Sell Rankings**: Sentiment analysis of the **1,000 latest market news articles**, checked against each stock's own AI analysis, ranks up to 5 **buy** and 5 **sell** stocks.
- **Trading**: Market, limit, stop, stop limit and trailing stop orders, fractional and dollar orders, bracket and OCO exits, extended hours, and short selling on margin.
- **Portfolio**: Open long and short positions with average cost, current price and profit/loss, a performance chart against SPY, tax lots, and an on-demand AI hold-or-sell analysis per position.
- **Accounts and Funding**: Simulated account opening, cash or margin accounts, traditional and Roth IRAs, ACH and wire deposits and withdrawals.
- **History and Documents**: Orders, trades, cash activity, trade confirmations, monthly statements, tax forms, and a gains and losses report.
- **Automation**: Price alerts, recurring buys, dividend reinvestment and notifications.

## Tech Stack

- **Next.js** (App Router) and **React**: pages and API route handlers in one app
- **TypeScript**: the whole codebase
- **Clerk**: sign-in
- **PostgreSQL**: database for accounts, orders, the ledger and transfers
- **Axios**: API requests

### APIs Used
- **Alpha Vantage API**: stock prices, news and company data
- **OpenAI API**: the AI analyses and rankings
- **Alpaca Market Data API** (optional): stock flags (shortable, fractionable), the order book and the market calendar

## Getting Started

### Prerequisites
Install:
- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 20.9 or later, with npm. The current LTS (22 or 24) is recommended. Avoid Node 22.7.0, which has a bug that corrupts some characters written to Postgres.
- [PostgreSQL](https://www.postgresql.org/download/) 14 or later, running locally (Homebrew, Postgres.app, the EDB installer or your Linux distribution's package all work)

Get these keys:
- **Alpha Vantage**: an API key from [alphavantage.co](https://www.alphavantage.co/support/#api-key) on a **premium plan with realtime U.S. market data**. A free key doesn't work: prices are requested with `entitlement=realtime`, which a free key refuses, so every page that needs a price fails.
- **OpenAI**: an API key from [platform.openai.com](https://platform.openai.com/api-keys) with access to the `gpt-6-luna` model (set in `lib/server/analysis.ts`).
- **Clerk**: create an application at [dashboard.clerk.com](https://dashboard.clerk.com) (the default email sign-in is enough) and copy its publishable and secret keys from **API Keys**. A development instance works on `localhost`.
- **Alpaca** (optional): the API key and secret of a free [Alpaca](https://alpaca.markets) trading account's **paper** keys, used for market data only. Without them the app still runs, but every stock is treated as shortable and fractionable and there's no order book.

### Installation
1. Clone the repository:
   ```sh
   git clone https://github.com/ikerfueyo/ai-stocktrader.git
   cd ai-stocktrader
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create a `.env.local` file in the project root with your settings:
   ```sh
   DB_USER=postgres
   DB_PASSWORD=yourpassword
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=ai_stocktrader
   ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key
   OPENAI_API_KEY=your_openai_api_key
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   # Optional: your Alpha Vantage plan's per-minute request limit (default 150)
   ALPHA_VANTAGE_REQUESTS_PER_MINUTE=150
   # Optional: Alpaca's free market data (a trading account's paper keys)
   # ALPACA_API_KEY_ID=your_alpaca_key_id
   # ALPACA_API_SECRET_KEY=your_alpaca_secret_key
   ```
   `DB_USER` and `DB_PASSWORD` are your Postgres login. The EDB installer and most Linux packages create a `postgres` user with the password you chose. Homebrew and Postgres.app create a user named after your computer login, with no password: use that name for `DB_USER` (and in the `psql -U` commands below) and leave `DB_PASSWORD` empty.

### Database Setup
With PostgreSQL running, create the database and its tables:
```sh
psql -U postgres -d postgres -c "CREATE DATABASE ai_stocktrader;"
psql -U postgres -d ai_stocktrader -v ON_ERROR_STOP=1 -f db/schema.sql
```
Replace `postgres` with your `DB_USER`, and `ai_stocktrader` with your `DB_NAME` if you changed it. A database created from `db/schema.sql` is up to date. A database created from an older version of the app is upgraded by applying the files in `db/migrations/` that it doesn't have yet, in numbered order.

### Running the Application
Start the development server:
```sh
npm run dev
```
Open `http://localhost:3000`, sign up or sign in with Clerk, and open a simulated account (made-up details only; the form explains the test values). Once it's approved, deposit simulated money from the **Deposit** page and start trading.

On its first start the server loads the list of tradable stocks and the market calendar in the background, which takes a few seconds. The first home page load builds the AI rankings, which takes a minute or so; later loads use the cached rankings.

For production, run `npm run build` and then `npm start`. Run the app as one long-lived Node server (as these commands do), not as serverless functions.

### Troubleshooting
- **`role "postgres" does not exist`**: your Postgres was installed with Homebrew or Postgres.app. Use your computer login name for `-U` and `DB_USER`.
- **Prices or charts fail with a 502 error**: the Alpha Vantage key isn't on a plan with realtime U.S. data, or its rate limit was reached. The server's terminal shows Alpha Vantage's message.
- **Clerk reports an infinite redirect loop, or sign-in never finishes**: the publishable and secret keys come from different Clerk applications or instances. Copy both from the same application's **API Keys** page.
- **`Connection terminated due to connection timeout`** or `ECONNREFUSED` on port 5432: Postgres isn't running, or `DB_HOST`/`DB_PORT` don't match it.

### Tests
```sh
npm test
```
runs the unit tests. `npm run lint` and `npm run typecheck` check the code.

## Project Structure
```
ai-stocktrader/
│── app/               # Pages (App Router) and API route handlers (app/api)
│── components/        # React components
│── context/           # Account context shared by the pages
│── lib/               # Shared types and client helpers
│   ├── server/        # Server-only code: database, market data, OpenAI, the simulated broker
│── db/                # Database schema and migrations
│── docs/              # Brokerage roadmap and going-live notes
│── public/            # Static files
│── vendor/alpaca/     # Alpaca's OpenAPI specs (the source of the generated types)
│── .env.local         # Environment variables (not committed)
│── package.json       # Project dependencies
│── README.md          # Documentation
```
