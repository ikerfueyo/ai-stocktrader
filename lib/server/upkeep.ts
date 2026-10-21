import "server-only";
import type { PoolClient } from "pg";
import { enforceCollateral, postDividends } from "./portfolio";
import { matchOrders } from "./orders";

// The account upkeep that runs before showing an account and in the background job: post paid dividends, run the buy-in check,
// then fill, trigger or expire open orders. Call it inside withAccountLock with its client.
export const updateAccount = async (userId: string, label: string, db: PoolClient) => {
    await postDividends(userId, label, db).catch(error => console.error(`${label}: dividends: ${error.message}`));
    const liquidations = await enforceCollateral(userId, label, db);
    await matchOrders(userId, label, db).catch(error => console.error(`${label}: orders: ${error.message}`));
    return liquidations;
};
