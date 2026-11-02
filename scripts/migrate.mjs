// Brings the database up to date before the server starts (the Docker image runs it ahead of server.js).
// An empty database gets db/schema.sql, which already includes every migration, so each migration file is recorded as applied.
// Otherwise the migrations not yet recorded in schema_migrations run in order, each in its own transaction. Migrations must be
// plain SQL (no psql meta-commands) and additive, since the previous version keeps serving while a deploy rolls out.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = path.join(root, "db");
const migrationsDir = path.join(dbDir, "migrations");
// Any fixed number unlike the app's own advisory locks (jobs.ts and the account locks hash text)
const MIGRATION_LOCK_KEY = 72_465_001;

const ssl = process.env.DB_SSL === "true"
    ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA ? readFileSync(process.env.DB_SSL_CA, "utf8") : undefined }
    : undefined;

const client = new pg.Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    ssl,
    connectionTimeoutMillis: 30_000
});

const migrationFiles = () => readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort();

// schema.sql starts with CREATE DATABASE for a manual setup; the database exists here
const schemaSql = () => readFileSync(path.join(dbDir, "schema.sql"), "utf8").replace(/^\s*CREATE DATABASE[^;]*;/im, "");

async function inTransaction(fn) {
    await client.query("BEGIN");
    try {
        await fn();
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
}

async function main() {
    await client.connect();
    // Two tasks starting together (a deploy overlapping the running one) migrate one at a time
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows: [{ empty }] } = await client.query(`SELECT NOT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ) AS empty`);
        const files = migrationFiles();

        if (empty) {
            console.log("migrate: empty database, applying db/schema.sql");
            await inTransaction(async () => {
                await client.query(schemaSql());
                for (const name of files) await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
            });
            console.log(`migrate: schema created, ${files.length} migrations recorded as applied`);
            return;
        }

        const { rows } = await client.query("SELECT name FROM schema_migrations");
        const applied = new Set(rows.map(row => row.name));
        // A database set up by hand before this script: its tables exist but nothing is recorded, so record what's there
        if (applied.size === 0) {
            console.log("migrate: existing schema without schema_migrations rows; recording every migration as applied");
            for (const name of files) await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
            return;
        }

        const pending = files.filter(name => !applied.has(name));
        for (const name of pending) {
            console.log(`migrate: applying ${name}`);
            await inTransaction(async () => {
                await client.query(readFileSync(path.join(migrationsDir, name), "utf8"));
                await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
            });
        }
        console.log(pending.length ? `migrate: applied ${pending.length}` : "migrate: up to date");
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
        await client.end();
    }
}

main().catch(error => {
    console.error("migrate failed:", error.message);
    process.exit(1);
});
