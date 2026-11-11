import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "./cache";

// Which of the user's brokerage accounts the work at hand is for, carried through the async calls of a request or a job: a request's
// active account (the active_account cookie, which ledgerAccountId checks is the user's and open), or the account a background job
// is working on. Without one, the app falls back to the user's newest open account.
interface RequestContext {
    // The account a request is for: the one its page shows (the X-Account-Id header), else the one the active_account cookie names
    activeAccountId?: string | null;
    // Whether the page named it: then it's that account or none, never another (a tab left on one account while another tab switched)
    pinned?: boolean;
    // The account a job is working on, used as is
    accountId?: string;
}

// The cookie the account switcher sets (POST /api/accounts/active)
export const ACTIVE_ACCOUNT_COOKIE = "active_account";

// The header each page's requests carry with the account it shows (AccountGate), so a tab acts on its own account whatever another
// tab switched the cookie to
export const ACCOUNT_HEADER = "x-account-id";

// A page's account that's no longer one of the user's open accounts (closed, or the database reset): reloading picks the active one
export const STALE_ACCOUNT_MESSAGE = "This page shows an account that's no longer open; reload the page";

const storage = singleton("requestContext", () => new AsyncLocalStorage<RequestContext>());

export const requestContext = (): RequestContext => storage.getStore() ?? {};

export const withRequestContext = <T>(context: RequestContext, fn: () => Promise<T>): Promise<T> => storage.run(context, fn);

// Runs fn with the app's account helpers (ledgerAccountId) working on one account, for a background job going through accounts
export const withLedgerAccount = <T>(accountId: string, fn: () => Promise<T>): Promise<T> => storage.run({ accountId }, fn);
