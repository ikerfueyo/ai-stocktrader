import "server-only";
import type { PoolClient } from "pg";
import { enforceMargin, postDividends } from "./portfolio";

// The account upkeep that runs before showing an account and in the background job: post paid dividends, then the broker's margin
// check (calls met, liquidation when due; the broker matches orders itself: the sim-orders job). Call it inside withAccountLock with
// its client.
export const updateAccount = async (userId: string, label: string, db: PoolClient) => {
    await postDividends(userId, label, db).catch(error => console.error(`${label}: dividends: ${error.message}`));
    return enforceMargin(userId, label, db);
};
