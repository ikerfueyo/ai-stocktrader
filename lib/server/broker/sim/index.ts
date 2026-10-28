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
import * as documents from "./documents";
import * as optionEvents from "./optionEvents";
import { fetchOptionChain, fetchOptionContract } from "../../marketData";
import { toAsset, toCalendar, toClock, toOptionContract } from "./shapes";

// The simulated brokerage (BROKER=sim): Alpaca's Broker API on Postgres. Accounts and onboarding (./accounts.ts), funding
// (./transfers.ts: bank links, recipient banks, transfers and the cash activities they post), the trading account, positions and
// ledger (./positions.ts), margin (./marginAccount.ts, ./calls.ts), orders (./orders.ts, options in ./optionOrders.ts), option
// exercise and expiration (./optionEvents.ts), locates (./locates.ts), documents (./documents.ts), option contracts, assets, the calendar
// and clock, and the event streams.

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
    exerciseOption = (accountId: string, symbol: string, request?: { qty?: string }) => optionEvents.exerciseOption(accountId, symbol, request);
    doNotExercise = optionEvents.doNotExercise;

    // GET /v1/options/contracts: the listed contracts of the underlyings asked for (the simulator lists by underlying only), in Alpaca's shape
    async listOptionContracts(query: Parameters<Broker["listOptionContracts"]>[0]) {
        const underlyings = String(query.underlying_symbols ?? "").split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
        if (underlyings.length === 0) throw new BrokerError(422, 40010001, "underlying_symbols is required");
        const chains = await Promise.all(underlyings.map(symbol => fetchOptionChain(symbol)));
        const gte = Number(query.strike_price_gte ?? -Infinity), lte = Number(query.strike_price_lte ?? Infinity);
        return chains.flatMap(chain => chain.contracts)
            .filter(contract => (!query.expiration_date || contract.expiration === query.expiration_date) && (!query.expiration_date_gte || contract.expiration >= query.expiration_date_gte)
                && (!query.expiration_date_lte || contract.expiration <= query.expiration_date_lte) && (!query.type || contract.type === query.type)
                && contract.strike >= gte && contract.strike <= lte)
            .slice(0, Math.min(10000, Number(query.limit ?? 100) || 100))
            .map(toOptionContract);
    }

    async getOptionContract(symbol: string) {
        const found = await fetchOptionContract(symbol);
        if (!found) throw new BrokerError(404, 40410000, `option contract not found for ${symbol}`);
        return toOptionContract(found.contract);
    }
    listIraExcessContributions = transfers.listIraExcessContributions;
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
    listDocuments = documents.listDocuments;
    downloadDocument = documents.downloadDocument;
}
