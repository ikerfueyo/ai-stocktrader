import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Broker } from "./broker";
import type { Account, AccountCreationRequest, Order, Transfer } from "./types";
import { accountSummary, CASH_ACTIVITY_TYPES, cashRowsOf, ledgerOf, listAllActivities, taxLotsOf } from "../brokerLedger";

// The brokerage scenarios, written against the Broker interface only, so the same steps run against the simulator
// (lib/server/broker/sim/scenarios.sim.ts, npm run test:scenarios) and against Alpaca's Broker API sandbox
// (lib/server/broker/alpaca/scenarios.sandbox.ts). What only a test broker can do (move a price, age a position, post a corporate
// action) is the harness's, and a scenario that needs a capability the harness lacks is skipped. Every account is a new one, with
// fake identities (the 123-45-6789 test SSN) and the 011000015 test routing number.

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
    // A split or cash dividend of the symbol taking effect today, then applied to the accounts holding it
    corporateAction?(action: { type: "SPLIT"; symbol: string; factor: number } | { type: "DIVIDEND"; symbol: string; amount: number }): Promise<void>;
    // The broker's margin check now (in the regular session: liquidation when equity is far below maintenance)
    enforceMargin?(accountId: string): Promise<void>;
    // A listed option contract to trade (the sandbox's), with its underlying
    optionContract?: { symbol: string; underlying: string };
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
    // Releases what the harness holds (the database pool) once the scenarios are done
    close?(): Promise<void>;
}

type Capability = "appLedger" | "thinlyTraded" | "setPrice" | "backdate" | "corporateAction" | "enforceMargin" | "optionContract";

const STOCKS = 4;
const roundCents = (value: number) => Math.round(value * 100) / 100;

// An application as the app sends it, with fake details
export const testApplication = (options: { margin?: boolean; options?: boolean; ira?: "traditional" | "roth" } = {}): AccountCreationRequest => {
    const signed = { signed_at: new Date().toISOString(), ip_address: "127.0.0.1" };
    const agreements = ["customer_agreement", "account_agreement", ...(options.margin ? ["margin_agreement"] : []), ...(options.options ? ["options_agreement"] : [])];
    return {
        account_type: options.ira ? "ira" : "trading",
        ...(options.ira ? { account_sub_type: options.ira } : {}),
        contact: { email_address: `scenario+${randomUUID().slice(0, 8)}@example.com`, phone_number: "+15555550100", street_address: ["20 N San Mateo Dr"], city: "San Mateo", state: "CA", postal_code: "94401", country: "USA" },
        identity: {
            given_name: "Scenario", family_name: "Tester", date_of_birth: "1980-01-15", tax_id: "123-45-6789", tax_id_type: "USA_SSN",
            country_of_citizenship: "USA", country_of_birth: "USA", country_of_tax_residence: "USA", funding_source: ["employment_income"],
            investment_experience_with_stocks: "over_5_years", ...(options.options ? { investment_experience_with_options: "1_to_5_years" } : {})
        },
        disclosures: { is_control_person: false, is_affiliated_exchange_or_finra: false, is_politically_exposed: false, immediate_family_exposed: false, employment_status: "retired" },
        agreements: agreements.map(agreement => ({ agreement, ...signed })),
        ...(options.ira ? { beneficiaries: [{ given_name: "Test", family_name: "Beneficiary", date_of_birth: "2000-02-02", tax_id: "123-45-6780", tax_id_type: "USA_SSN", relationship: "other", type: "primary", share_pct: "100" }] } : {}),
        enabled_assets: options.options ? ["us_equity", "us_option"] : ["us_equity"]
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

const positionQty = async (h: ScenarioHarness, accountId: string, symbol: string) =>
    Number((await h.broker.listPositions(accountId)).find(position => position.symbol === symbol)?.qty ?? 0);

interface Scenario {
    name: string;
    needs?: Capability[];
    run(h: ScenarioHarness): Promise<void>;
}

export const SCENARIOS: Scenario[] = [
    {
        name: "onboard: an application is reviewed to ACTIVE, and the full SSN never comes back",
        async run(h) {
            const account = await onboard(h);
            assert.ok(account.account_number);
            assert.ok(!JSON.stringify(account).includes("123-45-6789"));
            assert.match(String(account.identity?.tax_id ?? ""), /6789$/);
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
            const accountId = await fundedAccount(h, 10000, { margin: true });
            await waitFor(h, "shorting to be enabled", async () => (await h.broker.getTradeAccount(accountId)).shorting_enabled);
            await filled(h, accountId, await placed(h, accountId, { symbol: h.symbols.other, side: "sell", qty: "3" }));
            const position = (await h.broker.listPositions(accountId)).find(({ symbol }) => symbol === h.symbols.other);
            assert.equal(position?.side, "short");
            assert.equal(Number(position?.qty), -3);
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
        name: "withdraw: an ACH withdrawal of withdrawable cash leaves the account",
        async run(h) {
            const accountId = await fundedAccount(h, 3000);
            const withdrawable = Number((await h.broker.getTradeAccount(accountId)).cash_withdrawable ?? 0);
            assert.ok(withdrawable >= 1000, `withdrawable ${withdrawable}`);
            const [link] = await h.broker.listAchRelationships(accountId);
            const transfer = await h.broker.createTransfer(accountId, { transfer_type: "ach", direction: "OUTGOING", amount: "1000.00", relationship_id: link.id } as never);
            await waitFor(h, "the withdrawal's completion", async () => (await h.broker.listTransfers(accountId)).some(({ id, status }) => id === transfer.id && status === "COMPLETE"));
            assert.equal(Number((await h.broker.getTradeAccount(accountId)).cash), 2000);
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
            assert.ok(Math.abs(summary.totalCash - (10000 - buyPrice * 10 + sellPrice * 4 - againPrice * 3)) < 0.011, `cash ${summary.totalCash}`);
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
        name: "options: a level 2 approval is requested and granted",
        async run(h) {
            const account = await onboard(h, { options: true });
            await h.broker.requestOptionsApproval(account.id, { level: 2 });
            const approval = await waitFor(h, "the options approval", async () => (await h.broker.listOptionsApprovals(account.id)).find(({ status }) => status === "APPROVED"));
            assert.equal(approval.approved_level, 2);
        }
    },
    {
        name: "options: a call is bought and closed",
        needs: ["optionContract"],
        async run(h) {
            const accountId = await fundedAccount(h, 10000, { options: true });
            await h.broker.requestOptionsApproval(accountId, { level: 2 });
            await waitFor(h, "the options approval", async () => (await h.broker.listOptionsApprovals(accountId)).some(({ status }) => status === "APPROVED"));
            const contract = await h.broker.getOptionContract(h.optionContract!.symbol);
            assert.equal(contract.underlying_symbol, h.optionContract!.underlying);
            await filled(h, accountId, await placed(h, accountId, { symbol: contract.symbol, side: "buy", qty: "1" }));
            assert.equal(await positionQty(h, accountId, contract.symbol), 1);
            await filled(h, accountId, await h.broker.closePosition(accountId, contract.symbol));
            assert.equal(await positionQty(h, accountId, contract.symbol), 0);
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
                await scenario.run(h);
            });
        }
    });
};
