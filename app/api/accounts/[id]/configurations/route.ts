import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { AccountConfigurations } from "@/lib/types";
import type { AccountContext } from "../route";

// Get the account's trading configurations (Alpaca's: margin multiplier, shorting, options level, fractional trading, trade
// suspension, confirmation emails)
export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    return NextResponse.json<AccountConfigurations>(await getBroker().getConfigurations(account_id));
});

const FIELDS = ["fractional_trading", "max_margin_multiplier", "max_options_trading_level", "no_shorting", "suspend_trade", "trade_confirm_email", "disable_overnight_trading"];

// Change them: body a partial AccountConfigurations. The broker refuses margin or shorting without the margin agreement, options
// above the approved level and overnight trading (422).
export const PATCH = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const body = await request.json().catch(() => null) as AccountConfigurations | null;
    if (!body || typeof body !== "object") throw new HttpError("A configuration change is required", 400);
    const unknown = Object.keys(body).filter(key => !FIELDS.includes(key));
    if (unknown.length > 0) throw new HttpError(`Unknown configurations: ${unknown.join(", ")}`, 400);
    return NextResponse.json<AccountConfigurations>(await getBroker().updateConfigurations(account_id, body));
});
