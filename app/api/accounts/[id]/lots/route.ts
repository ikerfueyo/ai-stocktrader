import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import { listLots } from "@/lib/server/broker/sim/positions";
import { brokerLedger, readsThroughBroker } from "@/lib/server/portfolio";
import { taxLotsOf } from "@/lib/server/brokerLedger";
import type { TaxLot } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's open tax lots (FIFO), by symbol and date: shares, price, cost basis and whether a sale now would be long-term.
// ?symbol= limits it to one. The simulator's own lots, or with Alpaca (whose API has no lots endpoint; its tax documents report them)
// the broker's fills replayed FIFO.
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const symbol = request.nextUrl.searchParams.get("symbol")?.toUpperCase();
    if (symbol !== undefined && !/^[A-Z0-9.]{1,15}$/.test(symbol)) throw new HttpError("A valid symbol is required", 400);
    if (!readsThroughBroker()) return NextResponse.json<TaxLot[]>(await listLots(account_id, symbol));
    return NextResponse.json<TaxLot[]>(taxLotsOf((await brokerLedger(account_id)).ledger.replay, symbol));
});
