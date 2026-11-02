// Brokerage account statuses as the pages and the server group them, and when an account can be closed

// Statuses an account doesn't come back from; a user with only these can apply again
export const FINAL_ACCOUNT_STATUSES = ["REJECTED", "ACCOUNT_CLOSED"];

// Statuses the app opens for: ACCOUNT_UPDATED is an active account whose edited details are being reviewed
export const OPEN_ACCOUNT_STATUSES = ["ACTIVE", "ACCOUNT_UPDATED"];

// Why an account can't be closed yet, or null: as with Alpaca, its positions must be closed, its open orders cancelled and its
// cash withdrawn first (a withdrawal already queued counts as gone)
export const closeAccountProblem = ({ positions, openOrders, cash, pendingTransferOut }: {
    positions: number; openOrders: number; cash?: string | number | null; pendingTransferOut?: string | number | null;
}): string | null => {
    if (positions > 0) return "Close your positions before closing the account";
    if (openOrders > 0) return "Cancel your open orders before closing the account";
    if (Math.abs(Number(cash ?? 0) - Number(pendingTransferOut ?? 0)) >= 0.01) return "Withdraw your cash before closing the account";
    return null;
};
