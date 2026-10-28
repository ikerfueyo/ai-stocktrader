import "server-only";
import pool from "../../db";
import { allAssets, findAsset } from "../../assets";
import { BrokerError } from "../errors";
import type { Broker, BrokerEvent, BrokerEventStream } from "../broker";
import * as accounts from "./accounts";
import * as transfers from "./transfers";
import * as positions from "./positions";
import * as orders from "./orders";
import * as margin from "./marginAccount";
import * as locates from "./locates";
import { toAsset, toCalendar, toClock } from "./shapes";

// The simulated brokerage (BROKER=sim): Alpaca's Broker API on Postgres. Accounts and onboarding (./accounts.ts), funding
// (./transfers.ts: bank links, recipient banks, transfers and the cash activities they post), the trading account, positions and
// ledger (./positions.ts), margin (./marginAccount.ts, ./calls.ts), orders (./orders.ts), locates (./locates.ts), assets, the calendar and clock, and the event streams are implemented; options and
// documents arrive in later phases (docs/brokerage-roadmap.md) and answer 501 until then.
const notYet = (what: string, phase: number) => (): never => {
    throw new BrokerError(501, 50100000, `${what} isn't simulated yet (phase ${phase} of the brokerage roadmap)`);
};

const EVENT_POLL_MS = 2000;

export class SimBroker implements Broker {
    createAccount = accounts.createAccount;
    getAccount = accounts.getAccount;
    updateAccount = accounts.updateAccount;
    closeAccount = accounts.closeAccount;
    uploadDocuments = accounts.uploadDocuments;
    getConfigurations = accounts.getConfigurations;
    updateConfigurations = accounts.updateConfigurations;
    listOptionsApprovals = accounts.listOptionsApprovals;
    requestOptionsApproval = (accountId: string, { level }: { level?: number }) => accounts.requestOptionsApproval(accountId, level ?? 0);

    listAssets = async () => (await allAssets()).map(asset => toAsset(asset, { hardToBorrow: margin.hardToBorrow(asset.symbol, asset) }));

    async getAsset(symbol: string) {
        const asset = await findAsset(symbol);
        if (!asset) throw new BrokerError(404, 40410000, `asset not found for ${symbol}`);
        return toAsset(asset, { hardToBorrow: margin.hardToBorrow(asset.symbol, asset) });
    }

    getCalendar = async (start: string, end: string) => toCalendar(start, end);
    getClock = async () => toClock(new Date());

    // Polls sim_events every 2 seconds for the account streams asked for, after sinceId (or from now), in order
    subscribe(streams: BrokerEventStream[], handler: (event: BrokerEvent) => Promise<void>, sinceId?: string) {
        let last = sinceId ?? null;
        let stopped = false;
        let polling = false;
        const poll = async () => {
            if (stopped || polling) return;
            polling = true;
            try {
                if (last === null) {
                    const { rows: [newest] } = await pool.query<{ id: string }>("SELECT max(id) AS id FROM sim_events");
                    last = newest?.id ?? "";
                }
                const { rows } = await pool.query<{ id: string; account_id: string; stream: BrokerEventStream; at: Date; payload: unknown }>(
                    "SELECT * FROM sim_events WHERE id > $1 AND stream = ANY($2) ORDER BY id LIMIT 500", [last, streams]
                );
                for (const row of rows) {
                    if (stopped) break;
                    await handler({ id: row.id, stream: row.stream, accountId: row.account_id, at: row.at.toISOString(), payload: row.payload });
                    last = row.id;
                }
            } catch (error) {
                console.error(`Sim events: ${error instanceof Error ? error.message : error}`);
            } finally {
                polling = false;
            }
        };
        const timer = setInterval(poll, EVENT_POLL_MS);
        timer.unref();
        poll();
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }

    getTradeAccount = margin.getTradeAccount;
    getPortfolioHistory = positions.getPortfolioHistory;
    createOrder = orders.createOrder;
    listOrders = orders.listOrders;
    getOrder = orders.getOrder;
    getOrderByClientOrderId = orders.getOrderByClientOrderId;
    replaceOrder = orders.replaceOrder;
    cancelOrder = orders.cancelOrder;
    cancelAllOrders = orders.cancelAllOrders;
    listPositions = positions.listPositions;
    getPosition = positions.getPosition;
    closePosition = orders.closePosition;
    listLocateQuotes = locates.listLocateQuotes;
    createLocate = locates.createLocate;
    listLocates = locates.listLocates;
    getLocate = locates.getLocate;
    exerciseOption = notYet("Options", 9);
    listOptionContracts = notYet("Options", 9);
    createAchRelationship = transfers.createAchRelationship;
    listAchRelationships = transfers.listAchRelationships;
    deleteAchRelationship = transfers.deleteAchRelationship;
    createRecipientBank = transfers.createRecipientBank;
    listRecipientBanks = transfers.listRecipientBanks;
    deleteRecipientBank = transfers.deleteRecipientBank;
    createTransfer = transfers.createTransfer;
    listTransfers = transfers.listTransfers;
    cancelTransfer = transfers.cancelTransfer;
    listActivities = transfers.listActivities;
    listDocuments = notYet("Documents", 7);
    downloadDocument = notYet("Documents", 7);
}
