import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "./cache";

// Which of the user's brokerage accounts the work at hand is for, carried through the async calls of a request or a job: a request's
// active account (the active_account cookie, which ledgerAccountId checks is the user's and open), or the account a background job
// is working on. Without one, the app falls back to the user's newest open account.
interface RequestContext {
    // The account the active_account cookie names (a request)
    activeAccountId?: string | null;
    // The account a job is working on, used as is
    accountId?: string;
}

// The cookie the account switcher sets (POST /api/accounts/active)
export const ACTIVE_ACCOUNT_COOKIE = "active_account";

const storage = singleton("requestContext", () => new AsyncLocalStorage<RequestContext>());

export const requestContext = (): RequestContext => storage.getStore() ?? {};

export const withRequestContext = <T>(context: RequestContext, fn: () => Promise<T>): Promise<T> => storage.run(context, fn);

// Runs fn with the app's account helpers (ledgerAccountId) working on one account, for a background job going through accounts
export const withLedgerAccount = <T>(accountId: string, fn: () => Promise<T>): Promise<T> => storage.run({ accountId }, fn);
