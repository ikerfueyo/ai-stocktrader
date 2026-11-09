# Going live with Alpaca

`AlpacaBroker` (`lib/server/broker/alpaca/`) implements the same `Broker` interface as the simulator, and `BROKER=alpaca` with the Broker API's OAuth client credentials selects it. The adapter is unit-tested against mocked HTTP, and the shared scenario suite has run against Alpaca's Broker API sandbox (results below) as well as `SimBroker`. With `BROKER=alpaca` the app reads accounts only through `Broker`; the last section lists what that path still lacks.

This document lists what's left before real accounts and real money. Most of it isn't code. The code that's left is in its own section at the end.

## Before anything else: run the scenarios in the sandbox

1. Get Broker API sandbox credentials from Alpaca's Broker dashboard. These are an OAuth client ID and secret, and sandbox and production credentials aren't interchangeable.
2. Put them in `.env.local` as `ALPACA_BROKER_CLIENT_ID` and `ALPACA_BROKER_CLIENT_SECRET`, with `ALPACA_BROKER_ENV=sandbox` (the default).
3. Run `npm run test:scenarios:sandbox` while the market is open. It refuses production credentials. Each run opens new sandbox accounts with fake identities. It moves only sandbox money.
4. Set `SCENARIO_PATIENCE=180` (15 minutes at the default 5s wait). The sandbox completes ACH deposits on a 10-minute cycle (at :00, :10, :20 and so on), so the default 5 minutes misses about half of them. A full run then takes well over an hour; `SCENARIO=<part of a name>` runs one scenario, and several can run at once as separate processes, each opening its own accounts.

### Results on 2026-10-29

Options have since been removed (2026-11-03): the app trades stocks only, so the correspondent doesn't need options and that part of the request to support can be withdrawn. The three options scenarios are gone; a stocks-only scenario checks that an option contract's order and a multi-leg order are refused.

5 passed (onboard, fund, buy, cancel, replace), 9 were skipped as simulator-only, and 11 failed. Support has been asked to enable options, IRAs, margin and withdrawals for the sandbox correspondent, which 10 of the failures wait on:
- options (options approval, option trade, options added later; since removed with options) and the IRA, refused by the correspondent (below, for the IRA);
- short, close position and margin upgrade, since accounts stay at 1x without shorting;
- withdraw, wire and close, since a deposit can't be withdrawn for 7 business days (below). These scenarios open new accounts, so they can't pass on a fresh deposit. They need an account funded at least 7 business days earlier, or a run that waits that long.

The eleventh, the ledger scenario, now allows for fees taken from cash before their FEE activity posts (below). What the run showed:
- **Withdrawals.** `cash_withdrawable` stays 0 after an ACH deposit completes, and an outgoing ACH transfer or wire is then refused with `forbidden.` (403, 40310000). It's a deposit hold, not a correspondent setting. Alpaca support said on 2026-11-06 that deposits generally become withdrawable on the 7th business day, and the sandbox does the same, counting business days after the deposit's day:
  - Both deposits completed on 2026-10-28 (407381006, 407700444) were withdrawable at 4:59 p.m. ET on 2026-11-06, their 7th business day.
  - The 17 completed on 2026-10-29 still showed 0 then, though 8 calendar days had passed and their `expires_at` (2026-11-05, 7 calendar days on) too, so that field isn't the release date. All 17 were withdrawable at 4:51 p.m. ET on 2026-11-09, their 7th business day.

  When in the day a deposit is released isn't known. `cash_transferable` showed the full amount during the hold. A withdrawal from a released account hasn't been tried. Still open: whether production holds deposits the same way, and what `cash_transferable` means. The simulator has no hold (`withdrawable` in `lib/server/broker/sim/marginAccount.ts`), so a completed deposit can be withdrawn at once; add one if production holds deposits the same way. The Withdraw page now caps the amount at `cash_withdrawable` and says the rest is held: open orders, unsettled sales, and otherwise deposits the broker still holds.
- **Fees.** Alpaca takes regulatory fees from cash at the trade and posts the FEE activity later. Three fills on 2026-10-29 left cash $0.04 below the fills' net, exactly the simulator's SEC fee ($0.0288) and CAT fee ($0.000017), each rounded up to the cent. Until the FEE activity posts, the activity ledger and Alpaca's `cash` differ by the day's fees; the simulator deducts them only at the end of the day.
- **Lag.** Right after a fill or a cancel, the activities and the open-orders list can be behind. A fill was missing from the activities (6 shares in the replayed lots against 9 in the position), and a cancelled order was still listed as open, though `getOrder` already said `canceled`. Neither recurred on a rerun.
- **Sandbox and TLS.** Inside Claude Code's Bash sandbox, Node can't read the macOS certificate trust settings, so every call to Alpaca fails with `fetch failed`. Run the suite outside it.

The run settles these questions, which the docs and the vendored specs leave open:
- **Stream resumption.** Do `since_id` (trades, funding) and `since_ulid` (accounts, NTAs) accept a synthetic ULID? The adapter starts each stream 10 minutes before the app's checkpoint (`resumeId`).
- **Event shapes.** Which `entry_type` values arrive on the NTA stream, and does a sub-type ever come with them? Do funding events use the `entity_type` `Transfer`?
- **Configurations.** The vendored spec has no GET for trading configurations, so `getConfigurations` reads the trading account's `user_configurations`, which is null until something is set.
- **IRAs in the sandbox.** As of 2026-10-29 the correspondent can't open them: `IRA accounts are not allowed for this correspondent` (40010001). Support has been asked to enable traditional and Roth IRAs. Its reply of 2026-11-06 says only that existing partners should contact their CSM or support for enablement, so this is still open.
- **IRA documents and notices.** Alpaca sends RMD notices to owners of RMD age but doesn't work out the amount. Its `AccountDocumentType` has no type for them, so the simulator files them as `tax_statement` with the sub-type `rmd_notice`, and the 1099-R and 5498 the same way. Check which type and sub-type Alpaca uses. Alpaca also flags IRAs that need spousal consent (married, in a community property state, with no spouse as a beneficiary) and leaves the partner to collect it by hand. Find out how that notice arrives and set up the collection. The app only shows a note in Settings, and it can tell who's married only when the applicant gave a marital status (optional in onboarding).
- **The upgrade to margin.** Alpaca accepts the margin agreement by PATCH, then refuses `max_margin_multiplier` 2 with `max_margin_multiplier provided 2 exceeds the current limit 1` (422). On 2026-10-29 that was still the case after funding $10,000 first. Accounts opened with the margin agreement (408790998, 408934916) also stay at `multiplier` 1 with `shorting_enabled` false at $10,000, with no configuration set. Alpaca's docs make 2x the default from $2,000 of equity, so this looks like the sandbox correspondent's limit, and support has been asked. Its reply of 2026-11-06 repeats the $2,000 rule without addressing these accounts, which were still at 1x without shorting that day. The deposit hold isn't the cause: on 2026-11-09 the three accounts with the margin agreement (408790998, 408934916, 408418023) had $10,000 each, all withdrawable, and were still at 1x without shorting, and 2x was refused again on 408790998. All 28 of the correspondent's accounts were at 1x. Settings now keeps the signed agreement when 2x is refused (422) and says the account stays at 1x until the broker raises its limit; checked against the sandbox on 2026-10-30 (account 409411512). The same run found that Settings didn't load at all for this correspondent, because listing options approvals was refused (`us_option is not enabled for correspondent`, 403); Settings no longer lists them.
- **Plaid processor tokens.** Is an ACH relationship request with only `processor_token` enough, or does Alpaca still want `account_owner_name` and `bank_account_type`?
- **Error codes.** Alpaca's codes and messages for the refusals the pages explain: buying power, PDT, wash trades, shorting, insufficient qty.
- **Documents.** Does the download redirect to a pre-signed link? What content type comes back?
- **Rate limits.** What are the Broker API's rate limits for this partner? The adapter retries a 429 twice, after `Retry-After`.

## Not code

### The broker partnership
- **The agreement and Alpaca's review.** That means a Broker API agreement with Alpaca, as a fully disclosed introducing relationship where each user has their own Alpaca account, and Alpaca's review of the app, its flows and its marketing before production credentials are issued.
- **KYC and CIP move to Alpaca.** Alpaca reviews applications. The simulator's review rules (`lib/server/broker/sim/kyc.ts`) only stood in for that. The app keeps validating the form (`lib/kyc.ts`).
- **Real agreements and Form CRS links.** The `/agreements/[name]` pages are placeholders. Each one has to be replaced with the real document or Alpaca's link:
  - the customer agreement, the account agreement and the margin agreement;
  - the IRA disclosure statement and custodial agreement;
  - the app's own Form CRS and privacy notice, if counsel decides the app needs them.

  The `signed_at` and IP recorded at signing must refer to the version that was shown.
- **Fees and limits.** Alpaca's fee schedule (revised Oct 12, 2026) confirmed the simulator's figures: the $15 outgoing domestic wire, the $25 ACH return, the 6.50% margin rate, the regulatory fees (SEC, TAF and CAT) and how the HTB borrow fee is computed. Check it again before launch, since it changes without notice. Outgoing ACATS ($25) and international wires ($35) aren't offered. The vendored Broker spec now has incoming ACATS (`/v1beta1/acats`: full and partial transfers of U.S. equities and cash, with contra brokers, statuses and assets), which the app doesn't model for any account. IRA transfers and rollovers aren't offered at all ("not yet supported", per Alpaca's IRA overview, Oct 2026). Confirm the production ACH limits and cutoff times. The deposit and withdraw forms still show the simulator's figures.

### Plaid
- **Production access.** That needs a Plaid production application, approval for the Auth product, and Alpaca enabled as a processor in the Plaid dashboard.
- **Configuration.** Set `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV=production`.
- **Without Plaid.** Banks are linked by routing and account number. Confirm with Alpaca how manually entered accounts are verified in production.

### Securities and investment-adviser counsel
- **The AI recommendations** are the main question:
  - the rankings;
  - the per-ticker BUY, SELL and HOLD verdicts;
  - above all, the personalized position analysis, which uses the user's own position and weight.

  Counsel has to decide whether they're investment advice (registering as an adviser, or restructuring them), how Reg BI or FINRA Rule 2210 apply to them, and what disclosures go on every page.
- **The track record** (`GET /api/analysis/track-record`) is performance advertising if users see it. It falls under the SEC Marketing Rule's rules on hypothetical performance.
- **Notifications, recurring buys, DRIP and price alerts** are app features on a real account, so their wording and consent need review.

### Market data
- **Licensing.** Showing realtime quotes to end users needs licensing:
  - Alpha Vantage's terms for redistribution;
  - exchange display fees and non-professional subscriber declarations;
  - Alpaca's SIP plan, if it's used.

### Security
- **SOC 2.** Alpaca expects partners to pass a security assessment.
- **Multi-factor sign-in.** Turn on multi-factor sign-in in Clerk.
- **Re-authentication.** Require it before withdrawals, bank link changes and changes to the account's details.
- **Reg S-P.** Write an incident response plan for Reg S-P, including the customer notices required by the 2024 amendments.
- **Secrets.** Store the OAuth client secret and the Plaid secret in a secrets manager, not in `.env.local`. Rotate them on a schedule.
- **Tax IDs.** An application's full SSN goes from the form straight to Alpaca and is never stored (accounts come back masked: `redactAccount`). Opening an IRA asks for it again. Keep it out of logs, analytics and error reports, including any request logging added later.
- **Penetration test.** Run one before launch.

### What the simulator can't model
Alpaca does these itself. The simulator's versions were approximations and go away with `BROKER=alpaca`:
- real fills, routing and liquidity, halts and LULD pauses, and trade busts and corrections;
- hard-to-borrow availability, borrow rates and locates (the Broker API has none);
- house margin requirements per symbol and the actual margin interest rate;
- voluntary corporate actions and their elections;
- real bank verification and ACH returns;
- real statements, confirmations and tax forms;
- OCC's assignment process;
- the order in which a margin liquidation closes positions. The simulator closes first what releases the most requirement per dollar. The sandbox can't force a margin call, so ask Alpaca how it orders a liquidation.

## Code still to do

With `BROKER=alpaca`, the app reads accounts only through the `Broker` interface: `lib/server/brokerLedger.ts`, used by `lib/server/portfolio.ts` and the account, lots, tax, order and transfer routes. The simulator's own background jobs are skipped (`simOnly` in `lib/server/jobs.ts`).

`BROKER_LEDGER=broker` makes the app read the simulator the same way. The scenario suite compares both paths on the same account, and they agree. What's left:
- **Figures Alpaca doesn't report.** These show as zero or nothing:
  - buying power held for open orders (`reservedCash`), accrued margin interest, margin calls (`marginCalls`, `marginStatus`, so no margin call banner or notifications), and liquidation fills;
  - why an order ended, which comes only with its trade event;
  - instant deposit credit.

  The margin rate shown is `ALPACA_MARGIN_RATE`. Margin calls could come from Alpaca's account events or reports, once their shape is known.
- **Lots and the gains report** come from replaying Alpaca's fills FIFO with the stored corporate actions (Alpha Vantage's splits, and Alpaca's stock dividends, mergers, spinoffs, symbol changes and worthless removals), applied as the simulator applies them, and a spinoff's or mixed merger's basis at the effective date's closes. The scenarios check the replay against the simulator's own lots after a spinoff and a stock merger. They're still the app's reconstruction. An action Alpaca's corporate actions API doesn't report, or reports differently from how Alpaca applied it, leaves them approximate, and so does a voluntary action. Alpaca's 1099 is the record.
- **Locates.** The Broker API has no locate endpoint (Alpaca's Trading API does, and requires a locate before an HTB short), so the adapter refuses them (501) and `GET /api/locates/quotes` answers `offered: false`. The order ticket then blocks short sales of hard-to-borrow stocks and says why. Ask Alpaca how Broker API partners' customers short HTB stocks, and wire that in if there's a way.
- **Funding terms.** `GET /api/funding` still shows the simulator's limits and fees, except instant credit (none). Replace them once Alpaca's are confirmed.
- **Plaid Link.** `BankLink` loads Plaid Link only when `GET /api/funding` says Plaid is available, which needs `BROKER=alpaca` and Plaid's keys. It hasn't been tried against Plaid's sandbox.
- **Cost.** Each account page load reads the account's whole activity history (Alpaca pages it 100 at a time). It's kept 5 seconds and dropped after every change and broker event. A long history would want a stored copy, kept current from the NTA and trade streams.
