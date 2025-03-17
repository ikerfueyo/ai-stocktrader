const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const axios = require("axios");
const app = express();
// import OpenAI from "openai";
const OpenAI = require("openai");
const openai = new OpenAI(OPENAI_API_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// ROUTES
// Get stocks news (Alpha Vantage API)
app.get("/", async(req, res) => {
    try {
        const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=1000&apikey=${ALPHA_VANTAGE_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error(error.message);
    }
});

// Get stocks news sentiment analysis (OpenAI API)
app.post("/gpt", async(req, res) => {
    try {
        const { prompt, news } = req.body;
        const formattedNews = news.map(item => `Title: ${item.title}\nSummary: ${item.summary}`).join("\n\n");
        const finalPrompt = `${formattedNews}\n\n${prompt}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a financial news sentiment analyst. Your task is to analyze the titles and summaries of news articles related to stocks and determine their sentiment. Provide a response based on the given prompt." },
                { role: "user", content: finalPrompt }
            ],
        });
        res.json(response.choices[0].message.content.trim());
    } catch (error) {
        console.error(error.message);
    }
});

// Create a transaction
app.post("/trading/:ticker", async(req, res) => {
    try {
        const { transaction } = req.body;
        const { date, type, ticker, price, quantity, total } = transaction;
        const newTransaction = await pool.query(
            'INSERT INTO transactions ("date", "type", ticker, price, quantity, total) VALUES($1, $2, $3, $4, $5, $6) RETURNING *',
            [date, type, ticker, price, quantity, total]
        );
        res.json(newTransaction.rows[0]);
    } catch (error) {
        console.error(error.message);
    }
});

// Get all transactions
app.get("/transactions", async(req, res) => {
    try {
        const allTransactions = await pool.query("SELECT * FROM transactions");
        res.json(allTransactions.rows);
    } catch (error) {
        console.error(error.message);
    }
});

// Get stock data (Alpha Vantage API)
app.get("/trading/:ticker", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=full&apikey=${ALPHA_VANTAGE_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error(error.message);
    }
});


// Get stock news (Alpha Vantage API)
app.get("/trading/news/:ticker", async(req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${ticker}&apikey=${ALPHA_VANTAGE_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error(error.message);
    }
});


app.listen(5001, () => {
    console.log("server has started on port 5001");
});