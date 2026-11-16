import "server-only";
import pool from "../../db";
import { allAssets, findAsset } from "../../assets";
import { BrokerError } from "../errors";
import { encodeTime } from "ulid";
import type { Broker, BrokerEvent, BrokerEventStream, EventCursor } from "../broker";
import * as accounts from "./accounts";
import * as transfers from "./transfers";
import * as positions from "./positions";
import * as orders from "./orders";
import * as margin from "./marginAccount";
import * as locates from "./locates";
import * as documents from "./documents";
import { toAsset, toCalendar, toClock } from "./shapes";
import { TRANSFER_FEES } from "./funding";
import type { CreateTransferRequest } from "../types";

// The simulated brokerage (BROKER=sim): Alpaca's Broker API on Postgres. Accounts and onboarding (./accounts.ts), funding
// (./transfers.ts: bank links, recipient banks, transfers and the cash activities they post), the trading account, positions and
// ledger (./positions.ts), margin (./marginAccount.ts, ./calls.ts), orders (./orders.ts), locates (./locates.ts), documents
// (./documents.ts), assets, the calendar and clock, and the event streams.

const EVENT_POLL_MS = 2000;

export class SimBroker implements Broker {
    createAccount = accounts.createAccount;
    getAccount = accounts.getAccount;
    updateAccount = accounts.updateAccount;
    closeAccount = accounts.closeAccount;
    uploadDocuments = accounts.uploadDocuments;
    getConfigurations = accounts.getConfigurations;
    updateConfigurations = accounts.updateConfigurations;

    listAssets = async () => (await allAssets()).map(asset => toAsset(asset, { hardToBorrow: margin.hardToBorrow(asset.symbol, asset) }));

    async getAsset(symbol: string) {
        const asset = await findAsset(symbol);
        if (!asset) throw new BrokerError(404, 40410000, `asset not found for ${symbol}`);
        return toAsset(asset, { hardToBorrow: margin.hardToBorrow(asset.symbol, asset) });
    }

    getCalendar = async (start: string, end: string) => toCalendar(start, end);
    getClock = async () => toClock(new Date());

    // Polls sim_events every 2 seconds for the account streams asked for, in ID order (one order for every stream), each stream after
    // its own cursor (or the shared one, or from now). An event the handler rejects stops the poll, and the next poll starts at it.
    // Events are written inside the transactions whose changes they report, so one can commit after a later ID is already visible:
    // a poll reads only IDs older than every transaction still open (their events will all have later IDs), so none is passed over.
    subscribe(streams: BrokerEventStream[], handler: (event: BrokerEvent) => Promise<void>, since?: EventCursor) {
        const handled: Partial<Record<BrokerEventStream, string>> = {};
        for (const stream of streams) {
            const start = since?.streams[stream] ?? since?.shared;
            if (start) handled[stream] = start;
        }
        // Everything up to here has been handled or skipped
        let scanned: string | null = null;
        let stopped = false;
        let polling = false;
        const poll = async () => {
            if (stopped || polling) return;
            polling = true;
            try {
                if (scanned === null) {
                    // From the oldest stream's cursor; a stream without one starts from now
                    const { rows: [newest] } = await pool.query<{ id: string | null }>("SELECT max(id) AS id FROM sim_events");
                    for (const stream of streams) handled[stream] ??= newest?.id ?? "";
                    scanned = streams.map(stream => handled[stream]!).sort()[0] ?? "";
                }
                const { rows: [{ ms }] } = await pool.query<{ ms: string }>(
                    `SELECT (EXTRACT(EPOCH FROM LEAST(clock_timestamp(), COALESCE(min(xact_start), clock_timestamp())) - interval '1 second') * 1000)::bigint AS ms
                     FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`
                );
                const before = `${encodeTime(Number(ms), 10)}${"0".repeat(16)}`;
                const { rows } = await pool.query<{ id: string; account_id: string; stream: BrokerEventStream; at: Date; payload: unknown }>(
                    "SELECT * FROM sim_events WHERE id > $1 AND id < $2 AND stream = ANY($3) ORDER BY id LIMIT 500", [scanned, before, streams]
                );
                for (const row of rows) {
                    if (stopped) break;
                    if (row.id > handled[row.stream]!) {
                        await handler({ id: row.id, stream: row.stream, accountId: row.account_id, at: row.at.toISOString(), payload: row.payload });
                        handled[row.stream] = row.id;
                    }
                    scanned = row.id;
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
    listIraExcessContributions = transfers.listIraExcessContributions;
    createAchRelationship = transfers.createAchRelationship;
    listAchRelationships = transfers.listAchRelationships;
    deleteAchRelationship = transfers.deleteAchRelationship;
    createRecipientBank = transfers.createRecipientBank;
    listRecipientBanks = transfers.listRecipientBanks;
    deleteRecipientBank = transfers.deleteRecipientBank;
    // A withdrawal (and any wire fee) beyond cash_withdrawable is refused as Alpaca refuses it (403 40310000), such as one of a deposit
    // still held; the transfers route checks first, with the reasons
    async createTransfer(accountId: string, request: CreateTransferRequest) {
        if (request.direction === "OUTGOING") {
            const amount = Number(request.amount) + (request.transfer_type === "wire" ? TRANSFER_FEES.wireOutDomestic : 0);
            const { withdrawable } = await margin.marginSnapshot(pool, accountId);
            if (amount > withdrawable + 0.005) throw new BrokerError(403, 40310000, `forbidden. $${amount.toFixed(2)} exceeds cash_withdrawable $${withdrawable.toFixed(2)}`);
        }
        return transfers.createTransfer(accountId, request);
    }
    listTransfers = transfers.listTransfers;
    cancelTransfer = transfers.cancelTransfer;
    listActivities = transfers.listActivities;
    listDocuments = documents.listDocuments;
    downloadDocument = documents.downloadDocument;
}
