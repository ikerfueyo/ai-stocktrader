// The shared brokerage scenarios (../scenarios.ts) against SimBroker, on a database of their own: npm run test:scenarios. It needs the
// local Postgres from .env.local; the database is DB_NAME with _test added (SCENARIO_DB_NAME to pick another, which must end in
// _test), created from db/schema.sql the first time. Prices are fixed (overridePrice) on two made-up symbols per run, the market is
// open (MARKET_HOURS_OVERRIDE), reviews are immediate (SIM_KYC_SECONDS=0) and transfers move a step per advance
// (fastForwardTransfers), so nothing calls Alpha Vantage. Run it with the react-server condition, which turns server-only off.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { defineScenarioTests, type ScenarioHarness } from "../scenarios";

try {
    process.loadEnvFile(".env.local");
} catch {
    // The variables may come from the environment instead
}
const database = process.env.SCENARIO_DB_NAME ?? `${process.env.DB_NAME ?? "ai_stocktrader"}_test`;
if (!database.endsWith("_test")) throw new Error(`The scenarios make accounts and orders: run them on a database whose name ends in _test, not ${database}`);
const letters = () => Array.from({ length: 2 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
// Made-up symbols, new each run, so corporate actions stored by an earlier run don't apply to this one's positions
const suffix = letters();
const SYMBOLS = { stock: `ZS${suffix}`, other: `ZT${suffix}`, thin: `ZU${suffix}` };
// The made-up user every scenario account belongs to
const USER = "user_scenarios";
Object.assign(process.env, {
    DB_NAME: database, MARKET_HOURS_OVERRIDE: "open", SIM_KYC_SECONDS: "0", SIM_KYC_REVIEW_SECONDS: "0", BACKGROUND_JOBS: "off",
    PRICE_OVERRIDES: JSON.stringify({ [SYMBOLS.stock]: 100, [SYMBOLS.other]: 50, [SYMBOLS.thin]: 20 })
});

const connection = () => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST, port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined
});

// Creates the database and its tables when they're missing
const prepareDatabase = async () => {
    const admin = new Client({ ...connection(), database: "postgres" });
    await admin.connect();
    try {
        const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
        if (!rowCount) await admin.query(`CREATE DATABASE "${database.replace(/"/g, "")}"`);
    } finally {
        await admin.end();
    }
    const client = new Client({ ...connection(), database });
    await client.connect();
    try {
        const { rows: [{ ready }] } = await client.query<{ ready: boolean }>("SELECT to_regclass('sim_accounts') IS NOT NULL AS ready");
        if (!ready) {
            const schema = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8").replace(/^CREATE DATABASE[^;]*;/m, "");
            await client.query(schema);
        }
    } finally {
        await client.end();
    }
};

const makeHarness = async (): Promise<ScenarioHarness> => {
    await prepareDatabase();
    // Loaded after the environment is set, since the modules read it when they load
    const [{ SimBroker }, { default: pool }, accounts, transfers, orders, positions, calls, { overridePrice }, { loadCorporateActions }, portfolio, { withLedgerAccount }] = await Promise.all([
        import("./index"), import("../../db"), import("./accounts"), import("./transfers"), import("./orders"), import("./positions"), import("./calls"),
        import("../../alphaVantage"), import("../../corporateActions"), import("../../portfolio"), import("../../requestContext")
    ]);
    // Their corporate actions count as fetched, so none is looked up at Alpha Vantage
    await pool.query(
        "INSERT INTO corporate_actions_checked (ticker, checked_at) SELECT unnest($1::text[]), now() ON CONFLICT (ticker) DO UPDATE SET checked_at = now()", [Object.values(SYMBOLS)]
    );
    // 1,000 shares traded today: the simulator fills a round lot per match
    overridePrice(SYMBOLS.thin, 20, 1000);
    const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    return {
        broker: new SimBroker(),
        symbols: { stock: SYMBOLS.stock, other: SYMBOLS.other },
        patience: 12,
        thinlyTraded: { symbol: SYMBOLS.thin, sharesPerFill: 100 },
        async advance() {
            await accounts.advanceAccounts();
            await transfers.fastForwardTransfers();
            await orders.matchOrders();
        },
        async setPrice(symbol, price) {
            overridePrice(symbol, price);
        },
        async backdate(accountId, days) {
            await pool.query(
                `UPDATE sim_activities SET created_at = created_at - make_interval(days => $2), "date" = "date" - $2::int, settle_date = settle_date - $2::int
                 WHERE account_id = $1 AND activity_type = 'FILL'`, [accountId, days]
            );
            await pool.query("UPDATE sim_lots SET acquired_at = acquired_at - make_interval(days => $2) WHERE account_id = $1", [accountId, days]);
        },
        async corporateAction(action) {
            await pool.query(
                `INSERT INTO corporate_actions (ticker, "type", ex_date, payment_date, factor, amount) VALUES ($1, $2, $3, $3, $4, $5)
                 ON CONFLICT (ticker, "type", ex_date) DO UPDATE SET factor = EXCLUDED.factor, amount = EXCLUDED.amount`,
                [action.symbol, action.type, today(), action.type === "SPLIT" ? action.factor : null, action.type === "DIVIDEND" ? action.amount : null]
            );
            if (action.type === "SPLIT") {
                await positions.applyDueCorporateActions();
                return;
            }
            const { rows } = await pool.query<{ account_id: string }>("SELECT DISTINCT account_id FROM sim_lots WHERE symbol = $1 AND qty > 0", [action.symbol]);
            const corporate = await loadCorporateActions([action.symbol]);
            for (const { account_id } of rows) await positions.postDividends(pool, account_id, corporate);
        },
        // As POST /api/accounts does: the account's user (a made-up one) and a W-9 certifying it isn't subject to backup withholding
        async onboarded(account) {
            await pool.query("INSERT INTO broker_accounts (account_id, user_id, broker, kind, account_number) VALUES ($1, $2, 'sim', $3, $4)",
                [account.id, USER, account.account_type === "ira" ? `${(account as { account_sub_type?: string }).account_sub_type}_ira` : "individual", account.account_number]);
            await pool.query("INSERT INTO account_attestations (account_id, kind, details, ip_address) VALUES ($1, 'w9', $2, '127.0.0.1')", [account.id, JSON.stringify({ backup_withholding: false })]);
        },
        // getAccount, getFills and loadCashActivity for the account's (made-up) user, with BROKER_LEDGER=broker for the Broker path
        async appLedger(accountId, throughBroker) {
            const previous = process.env.BROKER_LEDGER;
            process.env.BROKER_LEDGER = throughBroker ? "broker" : "";
            portfolio.forgetBrokerLedger(accountId);
            try {
                return await withLedgerAccount(accountId, async () => {
                    const { positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledProceeds } = await portfolio.getAccount(USER);
                    const fills = (await portfolio.getFills(USER)).map(({ id, realized_pnl, total, settle_date }) => ({ id, realized_pnl, total, settle_date }));
                    const cash = (await portfolio.loadCashActivity(USER)).map(({ type, amount }) => ({ type, amount }));
                    return { account: { positions, totalCash, realizedPnl, netDividends, pendingTransferOut, unsettledProceeds }, fills, cash };
                });
            } finally {
                process.env.BROKER_LEDGER = previous ?? "";
            }
        },
        async enforceMargin(accountId) {
            await calls.enforceMargin(accountId);
        },
        close: () => pool.end()
    };
};

defineScenarioTests("Brokerage scenarios (SimBroker)", makeHarness, process.env.SCENARIO);
