import "server-only";
import { auth, clerkClient, reverificationError } from "@clerk/nextjs/server";
import { HttpError } from "./httpError";
import { brokerMode } from "./broker/broker";
import { singleton } from "./cache";

// Guards for the routes that move money or change who owns an account (withdrawals, bank links and wire recipients, the account's
// details, its configurations, the W-9, opening an IRA, closing the account).
//
// requireRecentSignIn: the session must have verified a factor in the last 10 minutes (Clerk's "strict" reverification: the second
// factor when the user has one, else the first). Otherwise 403 with Clerk's reverification hint beside { error }, which the pages'
// useReverifiedRequest turns into Clerk's re-verification modal, then retries.
//
// requireSecondFactor: with REQUIRE_MFA (default on with BROKER=alpaca, off with the simulator), trading and moving money need
// two-step verification turned on (Clerk's twoFactorEnabled). "strict" alone falls back to the first factor for a user without one,
// and Clerk's dashboard "Require MFA" setting is per instance, so this check doesn't depend on it.

export const mfaRequired = () => (process.env.REQUIRE_MFA ?? (brokerMode() === "alpaca" ? "true" : "false")).toLowerCase() === "true";

// Users known to have two-step verification on, for a minute (one turning it on isn't kept waiting)
const secondFactorOn = singleton("secondFactorOn", () => new Map<string, number>());

export const requireSecondFactor = async (userId: string) => {
    if (!mfaRequired()) return;
    const knownUntil = secondFactorOn.get(userId);
    if (knownUntil && knownUntil > Date.now()) return;
    const user = await (await clerkClient()).users.getUser(userId);
    if (!user.twoFactorEnabled) {
        throw new HttpError("Turn on two-step verification first: open your profile (the picture at the top right), Manage account, Security", 403);
    }
    secondFactorOn.set(userId, Date.now() + 60_000);
};

export const requireRecentSignIn = async (userId: string) => {
    await requireSecondFactor(userId);
    const { has } = await auth();
    if (!has({ reverification: "strict" })) throw new HttpError("Confirm it's you to continue", 403, reverificationError("strict"));
};
