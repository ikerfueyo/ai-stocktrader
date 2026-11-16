import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Broker } from "./broker";
import type { Account, AccountCreationRequest, Order, Transfer } from "./types";
import { accountSummary, CASH_ACTIVITY_TYPES, cashRowsOf, ledgerOf, listAllActivities, taxLotsOf } from "../brokerLedger";
import { feesFor, roundFeeUp } from "./sim/feeSchedule";
import { closeAccountProblem } from "../../accounts";
import { nextTradingDay } from "../../marketHours";

// The brokerage scenarios, written against the Broker interface only, so the same steps run against the simulator
// (lib/server/broker/sim/scenarios.sim.ts, npm run test:scenarios) and against Alpaca's Broker API sandbox
// (lib/server/broker/alpaca/scenarios.sandbox.ts). What only a test broker can do (move a price, age a position, post a corporate
// action) is the harness's, and a scenario that needs a capability the harness lacks is skipped. Every account is a new one, with
// fake identities (made-up SSNs Alpaca accepts: it refuses sequences such as 123-45-6789) and the 011000015 test routing number,
// except that the scenarios a new account can't run at Alpaca (shorting, which needs margin enabled by support, and withdrawals, which
// wait 7 business days for the deposit's hold) use the harness's existing account when it has one.

export interface ScenarioHarness {
    broker: Broker;
    // Two stocks the broker trades, marginable and easy to borrow
    symbols: { stock: string; other: string };
    // Lets the broker's own work happen: account reviews, bank verification, a transfer's next step, order matching
    advance(): Promise<void>;
    // How many times advance may be called while waiting for something (the sandbox's reviews and transfers take a while)
    patience: number;
    // A stock so thinly traded that whole-share orders fill at most sharesPerFill at a time (the simulator's liquidity per match)
    thinlyTraded?: { symbol: string; sharesPerFill: number };
    // Fixes a symbol's price (the simulator's PRICE_OVERRIDES)
    setPrice?(symbol: string, price: number): Promise<void>;
    // Moves the account's fills and lots back that many days, as if its positions had been held since then
    backdate?(accountId: string, days: number): Promise<void>;
    // A split, cash dividend or spinoff of the symbol taking effect today, then applied to the accounts holding it
    corporateAction?(action: { type: "SPLIT"; symbol: string; factor: number } | { type: "DIVIDEND"; symbol: string; amount: number } | { type: "SPINOFF" | "STOCK_MERGER"; symbol: string; newSymbol: string; factor: number }): Promise<void>;
    // The broker's true-up of today's spinoffs' basis with today's closes (the current prices), as it runs once the session is over
    basisTrueUp?(): Promise<void>;
    // The broker's margin check now (in the regular session: liquidation when equity is far below maintenance)
    enforceMargin?(accountId: string): Promise<void>;
    // FINRA Rule 4210(d)(2) intraday margin, which Alpaca applies on its side: the broker's end of day for the account at day's close (a
    // trading day, today or later, as the eod job runs it), and the account's intraday margin deficits outstanding with the last day of
    // a 90-day restriction in force (null if none). A deficit unmet at its 5th business day restricts the account the first time.
    intradayMargin?: {
        endOfDay(accountId: string, day: string): Promise<void>;
        status(accountId: string): Promise<{ deficits: { date: string; amount: number; deMinimis: boolean; restrictOn: string }[]; restrictedUntil: string | null }>;
    };
    // Transfers wait for advance before each step, so one can be canceled while it's requested, and a deposit with test cents ($x.01)
    // comes back as R01 after it completes, with this return fee (the simulator's funding rules)
    transferSteps?: { returnFee: number };
    // What the app records itself once an account is opened (its W-9 certification, without which sales and dividends are subject
    // to backup withholding)
    onboarded?(account: Account): Promise<void>;
    // The app's own account helpers on the account (lib/server/portfolio.ts), reading the broker's ledger directly or, throughBroker,
    // through the Broker interface as for Alpaca, so the two can be compared
    appLedger?(accountId: string, throughBroker: boolean): Promise<{
        account: Record<string, unknown>;
        fills: { id: string | number; realized_pnl: number | null; total: string; settle_date?: string | null }[];
        cash: { type: string; amount: string }[];
    }>;
    // Ends the hold on the account's completed deposits, as if they had arrived 7 business days ago (the simulator). Without it a new
    // account's deposit can't be withdrawn for 7 business days, as at Alpaca.
    releaseDeposits?(accountId: string): Promise<void>;
    // An existing account to run on where a new one can't (SCENARIO_ACCOUNT_ID in the sandbox): ACTIVE, margin enabled with shorting,
    // and at least $3,000 that can be withdrawn, with no position or open order in the two symbols
    account?: string;
    // Releases what the harness holds (the database pool) once the scenarios are done
    close?(): Promise<void>;
}

type Capability = "appLedger" | "thinlyTraded" | "setPrice" | "backdate" | "corporateAction" | "basisTrueUp" | "enforceMargin" | "intradayMargin" | "transferSteps";

const STOCKS = 4;
const roundCents = (value: number) => Math.round(value * 100) / 100;

// An agreement as the app's account routes sign it
const signedNow = (agreement: string) => ({ agreement, signed_at: new Date().toISOString(), ip_address: "127.0.0.1" }) as never;

// An application as the app sends it, with fake details
export const testApplication = (options: { margin?: boolean; ira?: "traditional" | "roth" } = {}): AccountCreationRequest => {
    const signed = { signed_at: new Date().toISOString(), ip_address: "127.0.0.1" };
    const agreements = ["customer_agreement", "account_agreement", ...(options.margin ? ["margin_agreement"] : [])];
    return {
        account_type: options.ira ? "ira" : "trading",
        ...(options.ira ? { account_sub_type: options.ira } : {}),
        contact: { email_address: `scenario+${randomUUID().slice(0, 8)}@example.com`, phone_number: "+15555550100", street_address: ["20 N San Mateo Dr"], city: "San Mateo", state: "CA", postal_code: "94401", country: "USA" },
        identity: {
            given_name: "Scenario", family_name: "Tester", date_of_birth: "1980-01-15", tax_id: "587-42-3816", tax_id_type: "USA_SSN",
            country_of_citizenship: "USA", country_of_birth: "USA", country_of_tax_residence: "USA", funding_source: ["employment_income"],
            annual_income_min: "50000", annual_income_max: "100000", liquid_net_worth_min: "50000", liquid_net_worth_max: "100000", total_net_worth_min: "100000", total_net_worth_max: "200000",
            investment_experience_with_stocks: "over_5_years", marital_status: "SINGLE"
        },
        disclosures: { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false, employment_status: "retired" },
        agreements: agreements.map(agreement => ({ agreement, ...signed })),
        ...(options.ira ? { beneficiaries: [{ given_name: "Test", family_name: "Beneficiary", date_of_birth: "2000-02-02", tax_id: "587-42-3825", tax_id_type: "USA_SSN", relationship: "other", type: "primary", share_pct: "100" }] } : {}),
        enabled_assets: ["us_equity"]
    } as AccountCreationRequest;
};

// Calls advance until check passes (returning its value), or fails saying what never happened
export const waitFor = async <T>(h: ScenarioHarness, what: string, check: () => Promise<T | null | undefined | false>): Promise<T> => {
    for (let attempt = 0; attempt <= h.patience; attempt++) {
        const value = await check();
        if (value) return value;
        await h.advance();
    }
    throw new assert.AssertionError({ message: `${what} didn't happen` });
};

const clientId = () => `scenario-${randomUUID()}`;

export const onboard = async (h: ScenarioHarness, options: Parameters<typeof testApplication>[0] = {}): Promise<Account> => {
    const created = await h.broker.createAccount(testApplication(options));
    assert.equal(created.status === "SUBMITTED" || created.status === "APPROVAL_PENDING" || created.status === "ACTIVE", true, `created as ${created.status}`);
    await h.onboarded?.(created);
    return waitFor(h, "the account's approval", async () => {
        const account = await h.broker.getAccount(created.id);
        assert.notEqual(account.status, "REJECTED");
        return account.status === "ACTIVE" ? account : null;
    });
};

export const fund = async (h: ScenarioHarness, accountId: string, amount: number, ira?: { tax_year: string }): Promise<Transfer> => {
    const relationship = await h.broker.createAchRelationship(accountId, {
        account_owner_name: "Scenario Tester", bank_account_type: "CHECKING", bank_account_number: "123456789", bank_routing_number: "011000015", nickname: "Scenario bank"
    });
    await waitFor(h, "the bank link's approval", async () => (await h.broker.listAchRelationships(accountId)).some(({ id, status }) => id === relationship.id && status === "APPROVED"));
    const transfer = await h.broker.createTransfer(accountId, {
        transfer_type: "ach", direction: "INCOMING", amount: amount.toFixed(2), relationship_id: relationship.id, ...(ira ? { ira } : {})
    } as never);
    return waitFor(h, "the deposit's completion", async () => (await h.broker.listTransfers(accountId)).find(({ id, status }) => id === transfer.id && status === "COMPLETE"));
};

// An account that's open and funded
const fundedAccount = async (h: ScenarioHarness, amount: number, options: Parameters<typeof testApplication>[0] = {}) => {
    const account = await onboard(h, options);
    await fund(h, account.id, amount);
    return account.id;
};

// The harness's existing account, checked for what the scenarios using it need: open, and flat in both symbols with no open orders,
// so they can count from zero
const existingAccount = async (h: ScenarioHarness, { margin = false }: { margin?: boolean } = {}): Promise<string> => {
    const accountId = h.account!;
    const [account, trading, positions, orders] = await Promise.all([
        h.broker.getAccount(accountId), h.broker.getTradeAccount(accountId), h.broker.listPositions(accountId), h.broker.listOrders(accountId, { status: "open" })
    ]);
    assert.equal(account.status, "ACTIVE", `the existing account ${accountId} is ${account.status}`);
    if (margin) assert.ok(trading.shorting_enabled && Number(trading.multiplier) >= 2, `the existing account ${accountId} is at ${trading.multiplier}x, shorting ${trading.shorting_enabled ? "on" : "off"}`);
    const symbols = Object.values(h.symbols);
    const busy = [...positions.map(({ symbol }) => symbol), ...orders.map(({ symbol }) => symbol)].filter(symbol => symbol && symbols.includes(symbol));
    assert.deepEqual(busy, [], `close the existing account's positions and orders in ${busy.join(", ")} first`);
    return accountId;
};

// A margin account that can sell short: the existing one, else a new one with $10,000 that the broker enables
const marginAccount = async (h: ScenarioHarness): Promise<string> => {
    if (h.account) return existingAccount(h, { margin: true });
    const accountId = await fundedAccount(h, 10000, { margin: true });
    await waitFor(h, "shorting to be enabled", async () => (await h.broker.getTradeAccount(accountId)).shorting_enabled);
    return accountId;
};

// An account with at least $1,000 that can be withdrawn: the existing one, else a new one with $3,000 whose deposit's hold has ended
const withdrawableAccount = async (h: ScenarioHarness): Promise<string> => {
    const accountId = h.account ? await existingAccount(h) : await fundedAccount(h, 3000);
    if (!h.account) await h.releaseDeposits!(accountId);
    const withdrawable = Number((await h.broker.getTradeAccount(accountId)).cash_withdrawable ?? 0);
    assert.ok(withdrawable >= 1000, `withdrawable ${withdrawable}`);
    return accountId;
};
const withdrawals = (h: ScenarioHarness) => h.account || h.releaseDeposits ? null : "a new account's deposit is held for 7 business days, and there's no existing account (SCENARIO_ACCOUNT_ID)";

const placed = (h: ScenarioHarness, accountId: string, request: Record<string, unknown>) =>
    h.broker.createOrder(accountId, { time_in_force: "day", type: "market", client_order_id: clientId(), ...request } as never);

// Orders' fields are all optional in Alpaca's spec; every order the broker returns has an ID
type AnyOrder = Pick<Order, "id" | "status"> & { type?: string };
const idOf = (order: AnyOrder) => order.id!;

const filled = (h: ScenarioHarness, accountId: string, order: AnyOrder) =>
    waitFor(h, `order ${order.id}'s fill`, async () => {
        const current = await h.broker.getOrder(accountId, idOf(order));
        assert.ok(!["canceled", "expired", "rejected"].includes(String(current.status)), `order ${order.status} became ${current.status}`);
        return current.status === "filled" ? current : null;
    });

// The app's ledger read directly and through the Broker interface (as with Alpaca) agree: positions, cash, realized P&L and each fill's
const sameBothWays = async (h: ScenarioHarness, accountId: string) => {
    const direct = await h.appLedger!(accountId, false), through = await h.appLedger!(accountId, true);
    // The positions in symbol order, as the two reads list them differently
    const bySymbol = ({ account }: { account: Record<string, unknown> }) =>
        ({ ...account, positions: [...(account.positions as { ticker: string }[])].sort((a, b) => a.ticker.localeCompare(b.ticker)) });
    assert.deepEqual(bySymbol(through), bySymbol(direct));
    assert.deepEqual(through.fills, direct.fills);
};

const positionQty = async (h: ScenarioHarness, accountId: string, symbol: string) =>
    Number((await h.broker.listPositions(accountId)).find(position => position.symbol === symbol)?.qty ?? 0);

interface Scenario {
    name: string;
    needs?: Capability[];
    // Why the harness can't run it, or null
    skipUnless?(h: ScenarioHarness): string | null;
    run(h: ScenarioHarness): Promise<void>;
}

export const SCENARIOS: Scenario[] = [
    {
        name: "onboard: an application is reviewed to ACTIVE, and the full SSN never comes back",
        async run(h) {
            const account = await onboard(h);
            assert.ok(account.account_number);
            assert.ok(!JSON.stringify(account).includes("587-42-3816"));
            // The simulator returns the last 4 digits; Alpaca's sandbox leaves the tax ID out
            const taxId = account.identity?.tax_id;
            if (taxId) assert.match(taxId, /3816$/);
        }
    },
    {
        name: "fund: a linked bank's ACH deposit completes and becomes cash",
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            const trading = await h.broker.getTradeAccount(accountId);
            assert.equal(Number(trading.cash), 5000);
            const deposits = (await h.broker.listActivities(accountId, { activity_types: "CSD" } as never)) as { net_amount?: string }[];
            assert.equal(roundCents(deposits.reduce((sum, { net_amount }) => sum + Number(net_amount), 0)), 5000);
        }
    },
    {
        name: "buy: a market order fills, opens the position and spends the cash",
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            const order = await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: String(STOCKS) }));
            assert.equal(Number(order.filled_qty), STOCKS);
            assert.equal(await positionQty(h, accountId, h.symbols.stock), STOCKS);
            const trading = await h.broker.getTradeAccount(accountId);
            assert.ok(Math.abs(Number(trading.cash) - (5000 - STOCKS * Number(order.filled_avg_price))) < 0.02, `cash ${trading.cash}`);
        }
    },
    {
        name: "short: a margin account sells a stock it doesn't hold",
        async run(h) {
            const accountId = await marginAccount(h);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "sell", qty: "3" }));
            const position = (await h.broker.listPositions(accountId)).find(({ symbol }) => symbol === h.symbols.other);
            assert.equal(position?.side, "short");
            assert.equal(Number(position?.qty), -3);
            // Covered, so an existing account is left as it was
            if (h.account) await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "buy", qty: "3", position_intent: "buy_to_close" }));
        }
    },
    {
        name: "close position: a long is sold in part by dollars then in full, and a short covered, as the Portfolio page closes them",
        async run(h) {
            const accountId = await marginAccount(h);
            const qtyOf = async (symbol: string) => (await h.broker.listPositions(accountId)).find(position => position.symbol === symbol)?.qty ?? "0";
            // The row's orders: day market orders with a closing intent, by dollars (a part of a long) or the shares held
            const close = (symbol: string, side: "buy" | "sell", size: { qty: string } | { notional: string }) =>
                placed(h, accountId, { symbol, side, ...size, position_intent: side === "sell" ? "sell_to_close" : "buy_to_close" });

            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: String(STOCKS) }));
            const part = await filled(h, accountId, await close(h.symbols.stock, "sell", { notional: "10.00" }));
            assert.ok(Number(part.filled_qty) > 0 && Number(part.filled_qty) < STOCKS, `sold ${part.filled_qty}`);
            const left = await qtyOf(h.symbols.stock);
            assert.ok(Math.abs(Number(left) - (STOCKS - Number(part.filled_qty))) < 1e-6, `left ${left}`);
            await filled(h, accountId, await close(h.symbols.stock, "sell", { qty: left }));
            assert.equal(await positionQty(h, accountId, h.symbols.stock), 0);

            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "sell", qty: "3" }));
            assert.equal(Number(await qtyOf(h.symbols.other)), -3);
            await filled(h, accountId, await close(h.symbols.other, "buy", { qty: "3" }));
            assert.equal(await positionQty(h, accountId, h.symbols.other), 0);
            // A closing order with nothing left to close is refused rather than opening the other side
            await assert.rejects(close(h.symbols.other, "buy", { qty: "1" }), (error: { status?: number }) => error.status === 403 || error.status === 422);
        }
    },
    {
        name: "partial fill: a large order fills in parts, then completely",
        needs: ["thinlyTraded"],
        async run(h) {
            const accountId = await fundedAccount(h, 50000);
            const { symbol, sharesPerFill } = h.thinlyTraded!;
            const qty = sharesPerFill + 50;
            const order = await placed(h, accountId, { symbol, side: "buy", qty: String(qty) });
            assert.equal(order.status, "partially_filled");
            assert.equal(Number(order.filled_qty), sharesPerFill);
            const done = await filled(h, accountId, order);
            assert.equal(Number(done.filled_qty), qty);
            const fills = (await h.broker.listActivities(accountId, { activity_types: "FILL" } as never)) as { order_id?: string; type?: string }[];
            assert.ok(fills.filter(({ order_id }) => order_id === order.id).length >= 2);
        }
    },
    {
        name: "replace: a resting limit order is replaced by a new order linked to it",
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            // Far below the market, so it rests
            const order = await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "2", type: "limit", limit_price: "1.00", time_in_force: "gtc" });
            assert.ok(["new", "accepted", "pending_new"].includes(String(order.status)), order.status);
            const replacement = await h.broker.replaceOrder(accountId, idOf(order), { qty: "3", limit_price: "1.01" } as never);
            assert.equal(replacement.replaces, order.id);
            assert.equal(Number(replacement.qty), 3);
            const original = await waitFor(h, "the original's replacement", async () => {
                const current = await h.broker.getOrder(accountId, idOf(order));
                return current.status === "replaced" ? current : null;
            });
            assert.equal(original.replaced_by, replacement.id);
            await h.broker.cancelOrder(accountId, idOf(replacement));
        }
    },
    {
        name: "cancel: one order, then all that are open",
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            const rest = (qty: string) => placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty, type: "limit", limit_price: "1.00", time_in_force: "gtc" });
            const first = await rest("1");
            await h.broker.cancelOrder(accountId, idOf(first));
            await waitFor(h, "the cancellation", async () => (await h.broker.getOrder(accountId, idOf(first))).status === "canceled");
            const others = [await rest("1"), await rest("2")];
            const results = await h.broker.cancelAllOrders(accountId);
            assert.deepEqual(results.map(({ id }) => id).sort(), others.map(({ id }) => id).sort());
            await waitFor(h, "every order's cancellation", async () => (await h.broker.listOrders(accountId, { status: "open" })).length === 0);
            assert.equal(await h.broker.getOrderByClientOrderId(accountId, first.client_order_id!).then(({ id }) => id), first.id);
        }
    },
    {
        name: "bracket: the entry fills, its take profit fills when the price rises and the stop loss is canceled",
        needs: ["setPrice"],
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            const price = 100;
            await h.setPrice!(h.symbols.stock, price);
            const entry = await placed(h, accountId, {
                symbol: h.symbols.stock, side: "buy", qty: "5", order_class: "bracket", time_in_force: "gtc",
                take_profit: { limit_price: "110.00" }, stop_loss: { stop_price: "90.00" }
            });
            await filled(h, accountId, entry);
            const legs = ((await h.broker.getOrder(accountId, idOf(entry))).legs ?? []) as AnyOrder[];
            assert.equal(legs.length, 2);
            await h.setPrice!(h.symbols.stock, 111);
            const takeProfit = legs.find(({ type }) => type === "limit")!, stopLoss = legs.find(({ type }) => type === "stop")!;
            await filled(h, accountId, takeProfit);
            await waitFor(h, "the stop loss's cancellation", async () => (await h.broker.getOrder(accountId, idOf(stopLoss))).status === "canceled");
            assert.equal(await positionQty(h, accountId, h.symbols.stock), 0);
        }
    },
    {
        name: "call: a margin account far below its maintenance requirement is liquidated",
        needs: ["setPrice", "enforceMargin"],
        async run(h) {
            await h.setPrice!(h.symbols.stock, 100);
            const accountId = await fundedAccount(h, 10000, { margin: true });
            await waitFor(h, "2x buying power", async () => Number((await h.broker.getTradeAccount(accountId)).buying_power) >= 19000);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "190" }));
            assert.ok(Number((await h.broker.getTradeAccount(accountId)).cash) < 0, "borrowing");
            // Equity 190 × 60 − 9,000 debit = 2,400, against 30% maintenance of 3,420: under 75% of it
            await h.setPrice!(h.symbols.stock, 60);
            await h.enforceMargin!(accountId);
            await waitFor(h, "the liquidation", async () => {
                const remaining = await positionQty(h, accountId, h.symbols.stock);
                return remaining < 190 && (await h.broker.listOrders(accountId, { status: "open" })).length === 0;
            });
            const trading = await h.broker.getTradeAccount(accountId);
            assert.ok(Number(trading.equity) >= Number(trading.maintenance_margin), `equity ${trading.equity} against maintenance ${trading.maintenance_margin}`);
        }
    },
    {
        name: "intraday margin: a day trade at 4x below maintenance leaves a deficit; unmet at its 5th business day it restricts the account until a deposit meets it",
        needs: ["setPrice", "intradayMargin"],
        async run(h) {
            await h.setPrice!(h.symbols.stock, 100);
            const accountId = await fundedAccount(h, 10000, { margin: true });
            await h.broker.updateConfigurations(accountId, { max_margin_multiplier: "4", no_shorting: false });
            await waitFor(h, "4x buying power", async () => Number((await h.broker.getTradeAccount(accountId)).buying_power) >= 39000);
            // $39,000 of stock on $10,000 of equity: 30% maintenance is $11,700, $1,700 more than the equity. Sold the same day, so no
            // call follows at the close, but the deficit stays.
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "390" }));
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "sell", qty: "390", position_intent: "sell_to_close" }));
            const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
            await h.intradayMargin!.endOfDay(accountId, today);
            const [deficit] = (await h.intradayMargin!.status(accountId)).deficits;
            assert.deepEqual([deficit?.date, deficit?.amount, deficit?.deMinimis], [today, 1700, false]);
            // Each later close until the 5th business day's: the restriction comes with that one
            let day = today;
            while (day < deficit.restrictOn) {
                day = nextTradingDay(day);
                assert.equal((await h.intradayMargin!.status(accountId)).restrictedUntil, null, `restricted before ${day}'s close`);
                await h.intradayMargin!.endOfDay(accountId, day);
            }
            const restricted = await h.intradayMargin!.status(accountId);
            assert.ok(restricted.restrictedUntil && restricted.restrictedUntil > deficit.restrictOn, `restricted until ${restricted.restrictedUntil}`);
            const trading = await h.broker.getTradeAccount(accountId);
            assert.deepEqual([String(trading.multiplier), trading.shorting_enabled], ["1", false]);
            await assert.rejects(placed(h, accountId, { symbol: h.symbols.other, side: "sell", qty: "3" }), (error: { status?: number }) => error.status === 403);
            // Buying with cash and closing still work; a deposit of the deficit meets it at the next close and lifts the restriction
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "10" }));
            const [link] = await h.broker.listAchRelationships(accountId);
            const deposit = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "INCOMING", amount: "1700.00", relationship_id: link.id } as never);
            await waitFor(h, "the deposit's completion", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === deposit.id && status === "COMPLETE"));
            await h.intradayMargin!.endOfDay(accountId, nextTradingDay(day));
            const lifted = await h.intradayMargin!.status(accountId);
            assert.deepEqual([lifted.deficits.length, lifted.restrictedUntil], [0, null]);
            assert.equal((await h.broker.getTradeAccount(accountId)).shorting_enabled, true);
        }
    },
    {
        name: "dividend: a long position held on the ex-date is paid",
        needs: ["backdate", "corporateAction"],
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "buy", qty: "10" }));
            await h.backdate!(accountId, 3);
            await h.corporateAction!({ type: "DIVIDEND", symbol: h.symbols.other, amount: 0.5 });
            const dividends = (await h.broker.listActivities(accountId, { activity_types: "DIV" } as never)) as { symbol?: string; net_amount?: string }[];
            assert.deepEqual(dividends.map(({ symbol, net_amount }) => [symbol, Number(net_amount)]), [[h.symbols.other, 5]]);
        }
    },
    {
        name: "split: a 2-for-1 split doubles the shares and halves the cost",
        needs: ["backdate", "corporateAction"],
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "buy", qty: "4" }));
            const before = (await h.broker.getPosition(accountId, h.symbols.other)).avg_entry_price;
            await h.backdate!(accountId, 3);
            await h.corporateAction!({ type: "SPLIT", symbol: h.symbols.other, factor: 2 });
            const after = await h.broker.getPosition(accountId, h.symbols.other);
            assert.equal(Number(after.qty), 8);
            assert.ok(Math.abs(Number(after.avg_entry_price) - Number(before) / 2) < 0.0001, `${after.avg_entry_price} against ${before}`);
        }
    },
    {
        name: "spinoff: the new company's shares take a share of the basis, trued up with the day's closes",
        needs: ["backdate", "corporateAction", "basisTrueUp", "setPrice", "appLedger"],
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            // A symbol of its own, so the splits and dividends other scenarios post today don't fall after its backdated fill
            const source = `${h.symbols.other}P`;
            const spun = `${source}S`;
            await h.setPrice!(source, 50);
            await filled(h, accountId, await placed(h, accountId, { symbol: source, side: "buy", qty: "10" }));
            const cost = Number((await h.broker.getPosition(accountId, source)).cost_basis);
            await h.backdate!(accountId, 3);
            // Applied at the open, at the quotes then: the source's $50 still includes the new company's $10, so it gets only a sixth
            await h.setPrice!(spun, 10);
            await h.corporateAction!({ type: "SPINOFF", symbol: source, newSymbol: spun, factor: 1 });
            const applied = Number((await h.broker.getPosition(accountId, spun)).avg_entry_price);
            assert.ok(Math.abs(applied - cost / 10 / 6) < 0.0001, `applied at ${applied}`);
            // 2 of the new shares sold the first day at $10
            await filled(h, accountId, await placed(h, accountId, { symbol: spun, side: "sell", qty: "2" }));
            // The sale is the only $20 fill
            const realized = async () => (await h.appLedger!(accountId, false)).fills.find(({ total }) => Math.abs(Number(total) - 20) < 0.01)?.realized_pnl ?? null;
            assert.ok(Math.abs(Number(await realized()) - 2 * (10 - applied)) < 0.02, `realized ${await realized()} before the true-up`);
            // The day's closes, $40 and $10: the new shares take 10 / 50 of the basis
            await h.setPrice!(source, 40);
            await h.basisTrueUp!();
            const [kept, received] = await Promise.all([h.broker.getPosition(accountId, source), h.broker.getPosition(accountId, spun)]);
            const share = 10 / 50;
            assert.ok(Math.abs(Number(kept.avg_entry_price) - cost / 10 * (1 - share)) < 0.0001, `source at ${kept.avg_entry_price}`);
            assert.ok(Math.abs(Number(received.avg_entry_price) - cost / 10 * share) < 0.0001, `new shares at ${received.avg_entry_price}`);
            // Nothing lost: the source's basis, the new shares' and the 2 sold add up to the cost
            assert.ok(Math.abs(Number(kept.cost_basis) + Number(received.cost_basis) + 2 * cost / 10 * share - cost) < 0.02);
            assert.ok(Math.abs(Number(await realized()) - 2 * (10 - cost / 10 * share)) < 0.02, `realized ${await realized()} after the true-up`);
            // Through the Broker interface the replay allocates the basis at the same closes
            await sameBothWays(h, accountId);
        }
    },
    {
        name: "merger: the shares move to the acquirer at its ratio, read the same through the Broker interface",
        needs: ["backdate", "corporateAction", "setPrice", "appLedger"],
        async run(h) {
            const accountId = await fundedAccount(h, 5000);
            // Symbols of their own, as the merger takes the target out of every account holding it
            const target = `${h.symbols.other}Q`, acquirer = `${h.symbols.other}M`;
            await h.setPrice!(target, 50);
            await h.setPrice!(acquirer, 120);
            await filled(h, accountId, await placed(h, accountId, { symbol: target, side: "buy", qty: "10" }));
            const cost = Number((await h.broker.getPosition(accountId, target)).cost_basis);
            await h.backdate!(accountId, 3);
            await h.corporateAction!({ type: "STOCK_MERGER", symbol: target, newSymbol: acquirer, factor: 0.5 });
            const received = await h.broker.getPosition(accountId, acquirer);
            assert.equal(Number(received.qty), 5);
            assert.ok(Math.abs(Number(received.cost_basis) - cost) < 0.01, `basis ${received.cost_basis} against ${cost}`);
            await filled(h, accountId, await placed(h, accountId, { symbol: acquirer, side: "sell", qty: "2" }));
            await sameBothWays(h, accountId);
        }
    },
    {
        name: "deposit hold: a new deposit can be traded with but not withdrawn, and a withdrawal of it is refused",
        async run(h) {
            const accountId = await fundedAccount(h, 3000);
            const trading = await h.broker.getTradeAccount(accountId);
            assert.equal(Number(trading.cash_withdrawable ?? 0), 0);
            assert.equal(Number(trading.cash_transferable ?? 0), 3000, "transferable within the broker");
            assert.ok(Number(trading.buying_power) >= 3000, `buying power ${trading.buying_power}`);
            const [link] = await h.broker.listAchRelationships(accountId);
            await assert.rejects(
                h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "100.00", relationship_id: link.id } as never),
                (error: { status?: number; code?: number }) => error.status === 403 && error.code === 40310000
            );
        }
    },
    {
        name: "withdraw: an ACH withdrawal of withdrawable cash leaves the account",
        skipUnless: withdrawals,
        async run(h) {
            const accountId = await withdrawableAccount(h);
            const cash = Number((await h.broker.getTradeAccount(accountId)).cash);
            const [link] = (await h.broker.listAchRelationships(accountId)).filter(({ status }) => status === "APPROVED");
            const transfer = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "1000.00", relationship_id: link.id } as never);
            await waitFor(h, "the withdrawal's completion", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === transfer.id && status === "COMPLETE"));
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), roundCents(cash - 1000));
        }
    },
    {
        name: "wire: a wire withdrawal to a recipient bank leaves the account with its fee",
        skipUnless: withdrawals,
        async run(h) {
            const accountId = await withdrawableAccount(h);
            const cash = Number((await h.broker.getTradeAccount(accountId)).cash);
            const bank = await h.broker.createRecipientBank(accountId, { name: "Scenario Bank", bank_code: "011000015", bank_code_type: "ABA", account_number: "987654321" } as never);
            assert.ok((await h.broker.listRecipientBanks(accountId)).some(({ id }) => id === bank.id));
            const transfer = await h.broker.createTransfer(accountId, { transfer_type: "wire", direction: "OUTGOING", amount: "500.00", bank_id: bank.id } as never);
            assert.equal(transfer.type, "wire");
            const done = await waitFor(h, "the wire's completion", async () => (await h.broker.listTransfers(accountId)).find(({ id, status }) => id === transfer.id && status === "COMPLETE"));
            const fee = Number(done.fee ?? 0);
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), roundCents(cash - 500 - fee));
            if (fee > 0) {
                const activities = await listAllActivities(h.broker, accountId, ["FEE"]);
                assert.ok(activities.some(activity => activity.activity_type === "FEE" && Number((activity as { net_amount?: string }).net_amount) === -fee), "the wire fee's activity");
            }
        }
    },
    {
        name: "cancel transfers: a requested deposit takes back its instant credit, a requested withdrawal releases its hold",
        needs: ["transferSteps"],
        async run(h) {
            const accountId = await fundedAccount(h, 3000);
            await h.releaseDeposits?.(accountId);
            const [link] = await h.broker.listAchRelationships(accountId);
            const deposit = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "INCOMING", amount: "500.00", relationship_id: link.id } as never);
            assert.equal(deposit.status, "QUEUED");
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), 3500, "credited at once up to the instant limit");
            await h.broker.cancelTransfer(accountId, deposit.id);
            const withdrawal = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "200.00", relationship_id: link.id } as never);
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).pending_transfer_out), 200);
            await h.broker.cancelTransfer(accountId, withdrawal.id);
            const transfers = await h.broker.listTransfers(accountId);
            assert.deepEqual([deposit.id, withdrawal.id].map(id => transfers.find(transfer => transfer.id === id)?.status), ["CANCELED", "CANCELED"]);
            const trading = await h.broker.getTradeAccount(accountId);
            assert.deepEqual([Number(trading.cash), Number(trading.pending_transfer_out)], [3000, 0]);
            // Once it's on its way, it can't be
            const late = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "100.00", relationship_id: link.id } as never);
            await waitFor(h, "the withdrawal going to clearing", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === late.id && status !== "QUEUED"));
            await assert.rejects(h.broker.cancelTransfer(accountId, late.id), (error: { status?: number }) => error.status === 422);
        }
    },
    {
        name: "return: a deposit with test cents completes, then comes back as R01 with the return fee",
        needs: ["transferSteps"],
        async run(h) {
            const accountId = await fundedAccount(h, 3000);
            const [link] = await h.broker.listAchRelationships(accountId);
            const deposit = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "INCOMING", amount: "250.01", relationship_id: link.id } as never);
            await waitFor(h, "the deposit's completion", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === deposit.id && status === "COMPLETE"));
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), 3250.01);
            const returned = await waitFor(h, "the deposit's return", async () => (await h.broker.listTransfers(accountId)).find(({ id, status }) => id === deposit.id && status === "RETURNED"));
            assert.match(String(returned.reason), /^R01/);
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), roundCents(3000 - h.transferSteps!.returnFee));
            const cash = cashRowsOf(await listAllActivities(h.broker, accountId, [...CASH_ACTIVITY_TYPES]), "scenario");
            assert.ok(cash.some(({ type, amount }) => type === "WITHDRAW" && Number(amount) === 250.01), "the return takes the deposit back");
        }
    },
    {
        name: "ledger: the app's view through the Broker interface agrees with the broker",
        async run(h) {
            const accountId = await fundedAccount(h, 10000);
            const buy = await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "10" }));
            const sell = await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "sell", qty: "4" }));
            const again = await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "3" }));
            const [trade, positions, activities, configurations] = await Promise.all([
                h.broker.getTradeAccount(accountId), h.broker.listPositions(accountId), listAllActivities(h.broker, accountId, ["FILL", ...CASH_ACTIVITY_TYPES]), h.broker.getConfigurations(accountId)
            ]);
            const ledger = ledgerOf({ trade, positions, activities, splits: [] });
            const [buyPrice, sellPrice, againPrice] = [buy, sell, again].map(order => Number(order.filled_avg_price));
            // FIFO: the 4 sold came from the first 10
            assert.ok(Math.abs(ledger.realizedPnl - (sellPrice - buyPrice) * 4) < 0.011, `realized ${ledger.realizedPnl}`);
            const position = positions.find(({ symbol }) => symbol === h.symbols.stock)!;
            const lots = taxLotsOf(ledger.replay, h.symbols.stock);
            assert.equal(lots.reduce((sum, { qty }) => sum + qty, 0), Number(position.qty));
            assert.ok(Math.abs(lots.reduce((sum, { qty, price }) => sum + qty * price, 0) / 9 - Number(position.avg_entry_price)) < 0.01, "average cost");
            assert.ok(Math.abs((buyPrice * 6 + againPrice * 3) / 9 - Number(position.avg_entry_price)) < 0.01);
            // The deposit, in one CSD or (the simulator's instant credit) more
            assert.equal(cashRowsOf(activities, "").filter(({ type }) => type === "DEPOSIT").reduce((sum, { amount }) => sum + Number(amount), 0), 10000);
            const summary = accountSummary({ trade, positions, configurations, ledger, marginRate: 0 });
            assert.equal(summary.equity, Math.round(Number(trade.equity) * 100) / 100);
            // Regulatory fees: the simulator accrues them and deducts them at the end of the day as FEE activities; Alpaca takes the same
            // amounts (each type's total rounded up) from cash at once and posts the FEE activity later
            const accrued: Record<string, number> = {};
            for (const [order, qty] of [[buy, 10], [sell, 4], [again, 3]] as const) {
                for (const { type, amount } of feesFor({ side: order.side as "buy" | "sell", qty, price: Number(order.filled_avg_price), date: String(order.filled_at).slice(0, 10) })) {
                    accrued[type] = (accrued[type] ?? 0) + amount;
                }
            }
            const fees = Object.values(accrued).reduce((sum, amount) => sum + roundFeeUp(amount), 0);
            const posted = (activities as { activity_type?: string; net_amount?: string }[]).filter(({ activity_type }) => activity_type === "FEE").reduce((sum, { net_amount }) => sum + Number(net_amount), 0);
            const fromFills = 10000 - buyPrice * 10 + sellPrice * 4 - againPrice * 3;
            assert.ok([fromFills + posted, fromFills - fees].some(expected => Math.abs(summary.totalCash - expected) < 0.011), `cash ${summary.totalCash}, ${fromFills} from the fills, fees ${fees}`);
            assert.deepEqual(summary.positions, [{ ticker: h.symbols.stock, quantity: 9 }]);
        }
    },
    {
        name: "ledger: the app reads the same account directly and through the Broker interface",
        needs: ["appLedger"],
        async run(h) {
            const accountId = await fundedAccount(h, 10000);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "10" }));
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.stock, side: "sell", qty: "4" }));
            await h.releaseDeposits?.(accountId);
            const [link] = await h.broker.listAchRelationships(accountId);
            await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "100.00", relationship_id: link.id } as never);
            const direct = await h.appLedger!(accountId, false), through = await h.appLedger!(accountId, true);
            assert.equal(direct.fills.length, 2);
            assert.ok(direct.fills.some(({ realized_pnl }) => realized_pnl !== null));
            assert.deepEqual(through.account, direct.account);
            assert.deepEqual(through.fills, direct.fills);
            const sorted = (rows: { type: string; amount: string }[]) => rows.map(({ type, amount }) => `${type} ${amount}`).sort();
            assert.deepEqual(sorted(through.cash), sorted(direct.cash));
        }
    },
    {
        name: "stocks only: an option contract's order and a multi-leg order are refused",
        async run(h) {
            const account = await onboard(h);
            const refused = (error: { status?: number }) => error.status !== undefined && error.status >= 400 && error.status < 500;
            await assert.rejects(h.broker.createOrder(account.id, { symbol: "F261120C00012000", side: "buy", type: "market", time_in_force: "day", qty: "1", client_order_id: randomUUID() }), refused);
            await assert.rejects(h.broker.createOrder(account.id, {
                order_class: "mleg", type: "limit", limit_price: "0.5", time_in_force: "day", qty: "1", client_order_id: randomUUID(),
                legs: [{ symbol: "F261120C00012000", side: "buy", ratio_qty: "1" }, { symbol: "F261120C00013000", side: "sell", ratio_qty: "1" }]
            } as never), refused);
            assert.equal((await h.broker.getAccount(account.id)).enabled_assets?.includes("us_option") ?? false, false);
        }
    },
    {
        name: "margin upgrade: a cash account signs the margin agreement, as Settings does, then borrows and sells short",
        async run(h) {
            const accountId = await fundedAccount(h, 10000);
            assert.equal(String((await h.broker.getTradeAccount(accountId)).multiplier), "1");
            await assert.rejects(h.broker.updateConfigurations(accountId, { max_margin_multiplier: "2", no_shorting: false }), (error: { status?: number }) => error.status === 422);
            await h.broker.updateAccount(accountId, { agreements: [signedNow("margin_agreement")] } as never);
            // As Settings does: shorting on, the multiplier left unset so the account gets the broker's limit (2x overnight, 4x intraday)
            await h.broker.updateConfigurations(accountId, { no_shorting: false });
            const trading = await waitFor(h, "margin to be enabled", async () => {
                const current = await h.broker.getTradeAccount(accountId);
                return Number(current.multiplier) >= 2 && current.shorting_enabled ? current : null;
            });
            assert.ok(Number(trading.buying_power) > Number(trading.cash), `buying power ${trading.buying_power} against cash ${trading.cash}`);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "sell", qty: "3" }));
            assert.equal(await positionQty(h, accountId, h.symbols.other), -3);
        }
    },
    {
        name: "close: an account closes once its orders are cancelled and its cash withdrawn, then takes no orders",
        // It closes the account, so it needs a new one whose deposit can be withdrawn
        skipUnless: h => h.releaseDeposits ? null : "a new account's deposit is held for 7 business days",
        async run(h) {
            const accountId = await fundedAccount(h, 1000);
            await h.releaseDeposits!(accountId);
            // What the close route checks first, from the broker's figures
            const problem = async () => {
                const [positions, orders, trading] = await Promise.all([h.broker.listPositions(accountId), h.broker.listOrders(accountId, { status: "open" }), h.broker.getTradeAccount(accountId)]);
                return closeAccountProblem({ positions: positions.length, openOrders: orders.length, cash: trading.cash, pendingTransferOut: trading.pending_transfer_out });
            };
            const resting = await placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "1", type: "limit", limit_price: "1.00" });
            assert.match(String(await problem()), /open orders/);
            await h.broker.cancelOrder(accountId, idOf(resting));
            await waitFor(h, "the order's cancellation", async () => (await h.broker.getOrder(accountId, idOf(resting))).status === "canceled");
            assert.match(String(await problem()), /cash/);
            const [link] = await h.broker.listAchRelationships(accountId);
            const withdrawal = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "1000.00", relationship_id: link.id } as never);
            await waitFor(h, "the withdrawal's completion", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === withdrawal.id && status === "COMPLETE"));
            assert.equal(await problem(), null);
            await h.broker.closeAccount(accountId);
            await waitFor(h, "the account's closing", async () => (await h.broker.getAccount(accountId)).status === "ACCOUNT_CLOSED");
            await assert.rejects(placed(h, accountId, { symbol: h.symbols.stock, side: "buy", qty: "1" }), (error: { status?: number }) => error.status === 403 || error.status === 422);
        }
    },
    {
        name: "IRA: a traditional IRA takes a contribution for a tax year, at 1x and without shorting",
        async run(h) {
            const account = await onboard(h, { ira: "traditional" });
            assert.equal(account.account_type, "ira");
            const year = String(new Date().getUTCFullYear());
            const contribution = await fund(h, account.id, 1000, { tax_year: year });
            assert.equal((contribution as Transfer & { ira?: { tax_year?: string } }).ira?.tax_year, year);
            const configurations = await h.broker.getConfigurations(account.id);
            assert.equal(String(configurations.max_margin_multiplier ?? "1"), "1");
            await assert.rejects(placed(h, account.id, { symbol: h.symbols.other, side: "sell", qty: "1" }), (error: { status?: number }) => error.status === 403 || error.status === 422);
        }
    }
];

// Registers every scenario as a test against the harness (made once, for the first scenario that runs)
export const defineScenarioTests = (label: string, makeHarness: () => Promise<ScenarioHarness>, only?: string) => {
    let harness: Promise<ScenarioHarness> | null = null;
    describe(label, () => {
        after(async () => {
            if (harness) await (await harness).close?.();
        });
        for (const scenario of SCENARIOS) {
            if (only && !scenario.name.includes(only)) continue;
            test(scenario.name, async context => {
                const h = await (harness ??= makeHarness());
                const missing = (scenario.needs ?? []).filter(capability => h[capability] === undefined);
                if (missing.length > 0) {
                    context.skip(`the harness can't ${missing.join(", ")}`);
                    return;
                }
                const reason = scenario.skipUnless?.(h);
                if (reason) {
                    context.skip(reason);
                    return;
                }
                await scenario.run(h);
            });
        }
    });
};
