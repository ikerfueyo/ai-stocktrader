import "server-only";
import { Pool } from "pg";
import { singleton } from "./cache";

// Next.js loads .env.local itself
const pool = singleton("pool", () => new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    // Each request holding an account lock (withAccountLock) keeps a connection for its duration, Alpha Vantage calls included
    max: 20,
    // In development, the first webpack compile of a route blocks the event loop for 30-40s, which would fire a 5s connect timeout
    connectionTimeoutMillis: process.env.NODE_ENV === "production" ? 5000 : 60000
}));

export default pool;
