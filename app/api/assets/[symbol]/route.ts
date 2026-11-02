import { NextResponse } from "next/server";
import { getBroker } from "@/lib/server/broker";
import { withUser } from "@/lib/server/errors";
import type { BrokerAsset } from "@/lib/types";

interface AssetContext {
    params: Promise<{ symbol: string }>;
}

// A tradable stock as the broker lists it (Alpaca's Asset): whether it's marginable, shortable and easy or hard to borrow, its margin
// requirements and whether it's fractionable, for the order ticket. 404 outside the universe.
export const GET = withUser(async (request, { params }: AssetContext) =>
    NextResponse.json<BrokerAsset>(await getBroker().getAsset((await params).symbol.toUpperCase())));
