import { NextResponse } from "next/server";
import { withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { BrokerTradeAccount } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's trading account as the broker reports it (Alpaca's TradeAccount: cash, withdrawable cash, buying power, equity
// and last_equity, market values, margin figures, accrued fees, pending withdrawals, flags)
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<BrokerTradeAccount>(await getBroker().getTradeAccount(account_id));
});
