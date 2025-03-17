# AI StockTrader

AI StockTrader is a full-stack web application that allows users to mock-trade over **200,000+ stocks** with **AI-driven insights**. The platform provides real-time stock prices, sentiment analysis on financial news, and an intuitive trading interface.

## Features

- **Stock Symbol Search**: Lookup any stock and access its real-time price, historical data, and AI-driven sentiment analysis.
- **AI-Powered Buy/Sell Recommendations**: Sentiment analysis on **250 latest stock news articles** using OpenAI API to rank the top 5 **buy** and **sell** stocks.
- **Real-Time Trading Interface**: View stock price, candlestick chart, and mock trade (buy/sell) functionality.
- **Transaction History**: Users can view their past mock transactions, including stock symbol, date, price, quantity, and total.

## Tech Stack

### Frontend:
- **React.js** – UI/UX framework
- **Axios** – API requests

### Backend:
- **Node.js & Express.js** – Server-side logic
- **PostgreSQL** – Database for transactions

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
2. Install dependencies for both frontend and backend:
   ```sh
   npm run install-all
   ```
3. Create a `.env` file inside the `server/` directory and configure your environment variables:
   ```sh
   DB_USER=postgres
   DB_PASSWORD=yourpassword
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=ai_stocktrader
   ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key
   OPENAI_API_KEY=your_openai_api_key
   ```

### Database Setup
Ensure PostgreSQL is running, then initialize the database:
```sh
psql -U postgres -c "CREATE DATABASE ai_stocktrader;"
```
Then, create the `transactions` table:
```sh
psql -U postgres -d ai_stocktrader -c "
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    date DATE,
    type VARCHAR(255),
    ticker VARCHAR(255),
    price DECIMAL(10, 2),
    quantity INT,
    total DECIMAL(10, 2)
);"
```

### Running the Application
Start both frontend and backend simultaneously:
```sh
npm start
```
The frontend will run at `http://localhost:3000` and the backend at `http://localhost:5001`.

## Project Structure
```
ai-stocktrader/
│── client/            # React frontend
│── server/            # Node.js backend
│   ├── .env           # Environment variables
│── package.json       # Project dependencies
│── README.md          # Documentation
```