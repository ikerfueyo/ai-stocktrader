// The shared brokerage scenarios (../scenarios.ts) against SimBroker, on a database of their own: npm run test:scenarios. It needs the
// local Postgres from .env.local; the database is DB_NAME with _test added (SCENARIO_DB_NAME to pick another, which must end in
// _test), created from db/schema.sql the first time. Prices are fixed (overridePrice) on made-up symbols per run, one with an option
// chain (overrideOptionChain), the market is open (MARKET_HOURS_OVERRIDE), reviews are immediate (SIM_KYC_SECONDS=0) and transfers
// move a step per advance (fastForwardTransfers), so nothing calls Alpha Vantage. Run it with the react-server condition, which turns server-only off.
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
// Made-up symbols, new each run, so corporate actions stored by an earlier run don't apply to this one's positions; the last has
// an option chain
const suffix = letters();
const SYMBOLS = { stock: `ZS${suffix}`, other: `ZT${suffix}`, thin: `ZU${suffix}`, optioned: `ZO${suffix}` };
// The made-up user every scenario account belongs to
const USER = "user_scenarios";
Object.assign(process.env, {
    DB_NAME: database, MARKET_HOURS_OVERRIDE: "open", SIM_KYC_SECONDS: "0", SIM_KYC_REVIEW_SECONDS: "0", BACKGROUND_JOBS: "off",
    // One missed deficit makes a practice, so the intraday margin scenario's restriction comes from its one deficit
    SIM_INTRADAY_PRACTICE_MISSES: "1",
    PRICE_OVERRIDES: JSON.stringify({ [SYMBOLS.stock]: 100, [SYMBOLS.other]: 50, [SYMBOLS.thin]: 20, [SYMBOLS.optioned]: 100 })
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
    const [{ SimBroker }, { default: pool }, accounts, transfers, orders, positions, calls, { overridePrice, overrideOptionChain }, { loadCorporateActions }, portfolio, { withLedgerAccount }, { TRANSFER_FEES }, marginAccount, { addDays, easternTime, isTradingDay, settlementDate }, { optionSymbol }] = await Promise.all([
        import("./index"), import("../../db"), import("./accounts"), import("./transfers"), import("./orders"), import("./positions"), import("./calls"),
        import("../../alphaVantage"), import("../../corporateActions"), import("../../portfolio"), import("../../requestContext"), import("./funding"), import("./marginAccount"),
        import("../../../marketHours"), import("../../../options")
    ]);
    // Their corporate actions count as fetched, so none is looked up at Alpha Vantage
    await pool.query(
        "INSERT INTO corporate_actions_checked (ticker, checked_at) SELECT unnest($1::text[]), now() ON CONFLICT (ticker) DO UPDATE SET checked_at = now()", [Object.values(SYMBOLS)]
    );
    // 1,000 shares traded today: the simulator fills a round lot per match
    overridePrice(SYMBOLS.thin, 20, 1000);
    const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    // A closing chain for the optioned symbol: a call and a put at 100, expiring on the first trading Friday about five weeks out, at
    // 30% implied volatility (quoted by the model from the stock's price)
    let expiration = addDays(today(), 35);
    while (new Date(`${expiration}T12:00:00Z`).getUTCDay() !== 5 || !isTradingDay(expiration)) expiration = addDays(expiration, 1);
    const contract = (type: "call" | "put") => {
        const symbol = optionSymbol({ underlying: SYMBOLS.optioned, expiration, type, strike: 100 });
        return {
            contractID: symbol, symbol: SYMBOLS.optioned, expiration, strike: "100.00", type, last: "3.45", mark: "3.45", bid: "3.40", bid_size: "10", ask: "3.50", ask_size: "10",
            volume: "100", open_interest: "1000", date: today(), implied_volatility: "0.30"
        };
    };
    overrideOptionChain(SYMBOLS.optioned, [contract("call"), contract("put")]);
    return {
        broker: new SimBroker(),
        symbols: { stock: SYMBOLS.stock, other: SYMBOLS.other },
        patience: 12,
        thinlyTraded: { symbol: SYMBOLS.thin, sharesPerFill: 100 },
        optionContract: { symbol: optionSymbol({ underlying: SYMBOLS.optioned, expiration, type: "call", strike: 100 }), underlying: SYMBOLS.optioned },
        transferSteps: { returnFee: TRANSFER_FEES.achReturn },
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
                `UPDATE sim_activities SET created_at = created_at - make_interval(days => $2), "date" = "date" - $2::int
                 WHERE account_id = $1 AND activity_type = 'FILL'`, [accountId, days]
            );
            // Each fill settles T+1 from its new trade date (trading days, not the days moved)
            const { rows: fills } = await pool.query<{ id: string; day: string }>(
                `SELECT id, (created_at AT TIME ZONE 'America/New_York')::date::text AS day FROM sim_activities WHERE account_id = $1 AND activity_type = 'FILL'`, [accountId]
            );
            for (const { id, day } of fills) await pool.query("UPDATE sim_activities SET settle_date = $2 WHERE id = $1", [id, settlementDate(day)]);
            await pool.query("UPDATE sim_lots SET acquired_at = acquired_at - make_interval(days => $2) WHERE account_id = $1", [accountId, days]);
        },
        async corporateAction(action) {
            await pool.query(
                `INSERT INTO corporate_actions (ticker, "type", ex_date, payment_date, factor, amount, new_ticker) VALUES ($1, $2, $3, $3, $4, $5, $6)
                 ON CONFLICT (ticker, "type", ex_date) DO UPDATE SET factor = EXCLUDED.factor, amount = EXCLUDED.amount, new_ticker = EXCLUDED.new_ticker`,
                [action.symbol, action.type, today(), action.type === "DIVIDEND" ? null : action.factor, action.type === "DIVIDEND" ? action.amount : null, "newSymbol" in action ? action.newSymbol : null]
            );
            if (action.type !== "DIVIDEND") {
                await positions.applyDueCorporateActions();
                return;
            }
            const { rows } = await pool.query<{ account_id: string }>("SELECT DISTINCT account_id FROM sim_lots WHERE symbol = $1 AND qty > 0", [action.symbol]);
            const corporate = await loadCorporateActions([action.symbol]);
            for (const { account_id } of rows) await positions.postDividends(pool, account_id, corporate);
        },
        // The corporate-actions job's true-up as it runs the next morning, with the current (overridden) prices as today's closes
        async basisTrueUp() {
            await positions.trueUpBasisAllocations(new Date(Date.now() + 86400000));
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
        intradayMargin: {
            async endOfDay(accountId, day) {
                // Today's now, so what the scenario did today came before it and what it does next comes after (a deposit made after a
                // deficit's day ended meets it only once it's later than the deficit's issue); a later day's at the eod job's time
                await calls.endOfDayAccount(accountId, day === today() ? new Date() : new Date(Math.max(Date.now(), easternTime(day, "20:15").getTime())));
            },
            async status(accountId) {
                const { deficits, restrictedUntil } = await marginAccount.intradayStatus(pool, accountId, today());
                return { deficits: deficits.map(row => ({ date: row.date, amount: Number(row.amount), deMinimis: row.de_minimis, restrictOn: row.restrict_on })), restrictedUntil };
            }
        },
        close: () => pool.end()
    };
};

defineScenarioTests("Brokerage scenarios (SimBroker)", makeHarness, process.env.SCENARIO);
