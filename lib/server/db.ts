import "server-only";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { singleton } from "./cache";

// RDS requires SSL: DB_SSL=true verifies the server against DB_SSL_CA (the RDS CA bundle in the image), else the system's CAs
const ssl = process.env.DB_SSL === "true"
    ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA ? readFileSync(process.env.DB_SSL_CA, "utf8") : undefined }
    : undefined;

// Next.js loads .env.local itself
const pool = singleton("pool", () => new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    ssl,
    // Each request holding an account lock (withAccountLock) keeps a connection for its duration, Alpha Vantage calls included
    max: 20,
    // In development, the first webpack compile of a route blocks the event loop for 30-40s, which would fire a 5s connect timeout
    connectionTimeoutMillis: process.env.NODE_ENV === "production" ? 5000 : 60000
}));

export default pool;
