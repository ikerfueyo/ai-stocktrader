// Brokerage account statuses as the pages and the server group them

// Statuses an account doesn't come back from; a user with only these can apply again
export const FINAL_ACCOUNT_STATUSES = ["REJECTED", "ACCOUNT_CLOSED"];

// Statuses the app opens for: ACCOUNT_UPDATED is an active account whose edited details are being reviewed
export const OPEN_ACCOUNT_STATUSES = ["ACTIVE", "ACCOUNT_UPDATED"];
