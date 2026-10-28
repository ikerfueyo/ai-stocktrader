import "server-only";
import type { PoolClient } from "pg";
import { enforceCollateral, postDividends } from "./portfolio";

// The account upkeep that runs before showing an account and in the background job: post paid dividends, then run the buy-in check
// (the broker matches orders itself: the sim-orders job). Call it inside withAccountLock with its client.
export const updateAccount = async (userId: string, label: string, db: PoolClient) => {
    await postDividends(userId, label, db).catch(error => console.error(`${label}: dividends: ${error.message}`));
    return enforceCollateral(userId, label, db);
};
