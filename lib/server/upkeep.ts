import "server-only";
import type { PoolClient } from "pg";
import { singleton } from "./cache";
import { enforceMargin, ledgerAccountId, postDividends } from "./portfolio";

// How often the pages' reads run the upkeep for an account: the accounts job's interval (ORDER_MATCH_INTERVAL_MS), so a margin call
// is met or enforced no later than the job would
const UPKEEP_INTERVAL_MS = Number(process.env.ORDER_MATCH_INTERVAL_MS ?? 30000);
// When each account's upkeep last finished
const lastUpkeep = singleton("accountUpkeep", () => new Map<string, number>());

// The account upkeep that runs before showing an account and in the background job: post paid dividends, then the broker's margin
// check (calls met, liquidation when due; the broker matches orders itself: the sim-orders job). Call it inside withAccountLock with
// its client. With throttle (the pages' GET routes, which the header calls after every change and every minute), it's skipped when
// it ran for the account within the interval, since each run values the account three times.
export const updateAccount = async (userId: string, label: string, db: PoolClient, { throttle = false } = {}) => {
    const accountId = await ledgerAccountId(userId, db);
    if (throttle && accountId && Date.now() - (lastUpkeep.get(accountId) ?? 0) < UPKEEP_INTERVAL_MS) return [];
    await postDividends(userId, label, db).catch(error => console.error(`${label}: dividends: ${error.message}`));
    const result = await enforceMargin(userId, label, db);
    if (accountId) lastUpkeep.set(accountId, Date.now());
    return result;
};

// After a change the upkeep should see on the next read (a deposit that may meet a margin call)
export const forgetUpkeep = (accountId: string) => {
    lastUpkeep.delete(accountId);
};
