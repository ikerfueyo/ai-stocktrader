import { NextResponse } from "next/server";
import { HttpError, withUser } from "@/lib/server/errors";
import { getBroker } from "@/lib/server/broker";
import { findUserAccount } from "@/lib/server/brokerAccounts";
import type { ActivityType } from "@/lib/server/broker/types";
import type { BrokerActivity } from "@/lib/types";
import type { AccountContext } from "../route";

const TYPES = /^[A-Z]{2,6}(,[A-Z]{2,6})*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Get the account's ledger activities, newest first: fills (FILL, with price, quantity and side), cash deposits and withdrawals (CSD,
// CSW), fees (FEE), dividends (DIV) and splits (SPLIT). ?types=FILL,DIV filters by type, ?after= and ?until= ("YYYY-MM-DD") by date,
// at most ?page_size= (default 100, up to 1000), read from the broker 100 at a time (Alpaca's largest page).
const BROKER_PAGE = 100;

export const GET = withUser(async (request, { params }: AccountContext, userId) => {
    const { account_id } = await findUserAccount(userId, (await params).id);
    const search = request.nextUrl.searchParams;
    const types = search.get("types");
    const after = search.get("after");
    const until = search.get("until");
    if ((types && !TYPES.test(types)) || (after && !DATE.test(after)) || (until && !DATE.test(until))) throw new HttpError("Bad types or dates", 400);
    const pageSize = Math.min(1000, Math.max(1, Number(search.get("page_size")) || 100));
    const activities: BrokerActivity[] = [];
    let pageToken: string | undefined;
    while (activities.length < pageSize) {
        const want = Math.min(BROKER_PAGE, pageSize - activities.length);
        const page = await getBroker().listActivities(account_id, {
            ...(types ? { activity_types: types.split(",") as ActivityType[] } : {}), ...(after ? { after } : {}), ...(until ? { until } : {}),
            direction: "desc", page_size: want, ...(pageToken ? { page_token: pageToken } : {})
        } as never);
        activities.push(...page);
        const last = (page[page.length - 1] as { id?: string } | undefined)?.id;
        if (page.length < want || !last || last === pageToken) break;
        pageToken = last;
    }
    return NextResponse.json<BrokerActivity[]>(activities);
});
