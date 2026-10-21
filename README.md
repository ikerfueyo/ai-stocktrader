# AI StockTrader

AI StockTrader is a full-stack web application that allows users to mock-trade over **200,000+ stocks** with **AI-driven insights**. The platform provides 15-minute delayed stock prices (with an Alpha Vantage premium plan), sentiment analysis on financial news, and an intuitive trading interface.

## Features

- **Stock Symbol Search**: Lookup any stock and access its real-time price, historical data, and AI-driven sentiment analysis.
- **AI-Powered Buy/Sell Recommendations**: Sentiment analysis on **250 latest stock news articles** using OpenAI API to rank the top 5 **buy** and **sell** stocks.
- **Real-Time Trading Interface**: View stock price, candlestick chart, and mock trade (buy/sell) functionality.
- **Portfolio**: View open long and short positions with average cost, current price, and unrealized profit/loss. Sell (or cover) right from each row, and click the AI button for an on-demand hold-or-sell sentiment analysis.
- **Transaction History**: Users can view their past mock transactions, including stock symbol, date, price, quantity, and total.

## Tech Stack

- **Next.js** (App Router) and **React** – pages and API route handlers in one app
- **TypeScript** – the whole codebase
- **Clerk** – sign-in, one account per user
- **PostgreSQL** – database for transactions and transfers
- **Axios** – API requests

### APIs Used:
- **Alpha Vantage API** – Stock price data and news articles
- **OpenAI API** – AI-driven sentiment analysis

## Getting Started

### Prerequisites
Make sure you have the following installed:
- Node.js
- PostgreSQL

### Installation
1. Clone the repository:
   ```sh
   git clone https://github.com/yourusername/ai-stocktrader.git
   cd ai-stocktrader
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create a `.env.local` file in the project root and configure your environment variables:
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
   # Optional: "delayed" (default, 15-minute delayed), "realtime", or empty for end-of-day prices on a free key
   ALPHA_VANTAGE_ENTITLEMENT=delayed
   ```

### Database Setup
Ensure PostgreSQL is running, then initialize the database:
```sh
psql -U postgres -c "CREATE DATABASE ai_stocktrader;"
```
Then create the tables:
```sh
psql -U postgres -d ai_stocktrader -f db/schema.sql
```
(Skip the `CREATE DATABASE` line at the top of the file if you already ran the command above.) Existing databases are upgraded with the numbered files in `db/migrations/`.

### Running the Application
Start the development server:
```sh
npm run dev
```
The app and its API (under `/api`) run at `http://localhost:3000`. For production, run `npm run build` and then `npm start`.

## Project Structure
```
ai-stocktrader/
│── app/               # Pages (App Router) and API route handlers (app/api)
│── components/        # React components
│── context/           # Account context shared by the pages
│── lib/               # Shared types and client helpers
│   ├── server/        # Server-only code: database, Alpha Vantage, OpenAI, account math
│── db/                # Database schema and migrations
│── public/            # Static files
│── .env.local         # Environment variables (not committed)
│── package.json       # Project dependencies
│── README.md          # Documentation
```