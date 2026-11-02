import "server-only";
import type { PoolClient } from "pg";
import pool from "../../db";
import { postActivity } from "./transfers";
import { backupWithholding } from "./tax";

// Backup withholding (IRC 3406): 24% of dividends and of sales' gross proceeds, withheld while the account's W-9 certification says
// it's subject to it, or none is on file. Posted as WH (FWH) activities, which Alpaca uses for withholding although the spec's
// ActivityType enum leaves WH out; reason says what it was withheld from, for the 1099s.

// Whether the account's dividends and proceeds are subject to backup withholding: its W-9 certification (the app's newest
// account_attestations w9) says it is, or there's none on file. IRAs aren't subject to it.
export const subjectToBackupWithholding = async (accountId: string, db: Pick<PoolClient, "query"> = pool): Promise<boolean> => {
    const { rows: [account] } = await db.query<{ account_type: string }>("SELECT account_type FROM sim_accounts WHERE id = $1", [accountId]);
    if (account?.account_type === "ira") return false;
    const { rows: [row] } = await db.query<{ details: { backup_withholding?: boolean } }>(
        "SELECT details FROM account_attestations WHERE account_id = $1 AND kind = 'w9' ORDER BY signed_at DESC, id DESC LIMIT 1", [accountId]
    ).catch(() => ({ rows: [] as { details: { backup_withholding?: boolean } }[] }));
    return !row || row.details?.backup_withholding === true;
};

// Withholds from an amount paid to the account (dividends, or a sale's gross proceeds) when it's subject to backup withholding
export const withhold = async (db: PoolClient | typeof pool, accountId: string, { amount, on, symbol, at }: { amount: number; on: "dividends" | "proceeds"; symbol: string; at: Date }) => {
    const withheld = backupWithholding(amount);
    if (!(withheld >= 0.01) || !(await subjectToBackupWithholding(accountId, db))) return null;
    return postActivity(db, {
        accountId, type: "WH", subType: "FWH", netAmount: -withheld, symbol, reason: on, at,
        description: `Backup withholding (24%) on ${on === "dividends" ? "the" : "the gross proceeds of the"} ${symbol} ${on === "dividends" ? "dividend" : "sale"}: $${amount.toFixed(2)}`
    });
};
