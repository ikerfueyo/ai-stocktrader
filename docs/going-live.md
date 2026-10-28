# Going live with Alpaca

`AlpacaBroker` (`lib/server/broker/alpaca/`) implements the same `Broker` interface as the simulator, and `BROKER=alpaca` with the Broker API's OAuth client credentials selects it. Nothing has connected to Alpaca yet: the adapter is unit-tested against mocked HTTP, and the shared scenario suite has run only against `SimBroker`. With `BROKER=alpaca` the app reads accounts only through `Broker`; the last section lists what that path still lacks.

This document lists what's left before real accounts and real money. Most of it isn't code. The code that's left is in its own section at the end.

## Before anything else: run the scenarios in the sandbox

1. Get Broker API sandbox credentials from Alpaca's Broker dashboard. These are an OAuth client ID and secret, and sandbox and production credentials aren't interchangeable.
2. Put them in `.env.local` as `ALPACA_BROKER_CLIENT_ID` and `ALPACA_BROKER_CLIENT_SECRET`, with `ALPACA_BROKER_ENV=sandbox` (the default).
3. Run `npm run test:scenarios:sandbox` while the market is open. It refuses production credentials. Each run opens new sandbox accounts with fake identities. It moves only sandbox money.
4. Optionally set `SCENARIO_OPTION_CONTRACT` (an OCC symbol listed in the sandbox) to include the option trade.

The run settles these questions, which the docs and the vendored specs leave open:
- **Stream resumption.** Do `since_id` (trades, funding) and `since_ulid` (accounts, NTAs) accept a synthetic ULID? The adapter starts each stream 10 minutes before the app's checkpoint (`resumeId`).
- **Event shapes.** Which `entry_type` values arrive on the NTA stream, and does a sub-type ever come with them? Do funding events use the `entity_type` `Transfer`?
- **Configurations.** The vendored spec has no GET for trading configurations, so `getConfigurations` reads the trading account's `user_configurations`, which is null until something is set.
- **Plaid processor tokens.** Is an ACH relationship request with only `processor_token` enough, or does Alpaca still want `account_owner_name` and `bank_account_type`?
- **Error codes.** Alpaca's codes and messages for the refusals the pages explain: buying power, PDT, wash trades, shorting, insufficient qty.
- **Documents.** Does the download redirect to a pre-signed link? What content type comes back?
- **Rate limits.** What are the Broker API's rate limits for this partner? The adapter retries a 429 twice, after `Retry-After`.

## Not code

### The broker partnership
- **The agreement and Alpaca's review.** That means a Broker API agreement with Alpaca, as a fully disclosed introducing relationship where each user has their own Alpaca account, and Alpaca's review of the app, its flows and its marketing before production credentials are issued.
- **KYC and CIP move to Alpaca.** Alpaca reviews applications. The simulator's review rules (`lib/server/broker/sim/kyc.ts`) only stood in for that. The app keeps validating the form (`lib/kyc.ts`).
- **Real agreements and Form CRS links.** The `/agreements/[name]` pages are placeholders. Each one has to be replaced with the real document or Alpaca's link:
  - the customer agreement, the account agreement, the margin agreement and the options agreement;
  - the IRA disclosure statement and custodial agreement;
  - the app's own Form CRS and privacy notice, if counsel decides the app needs them.

  The `signed_at` and IP recorded at signing must refer to the version that was shown.
- **Fees and limits.** Confirm Alpaca's fee schedule: wires, ACH returns, ACATS, and the option ORF, OCC and CAT fees. Confirm the production ACH limits and cutoff times. The deposit and withdraw forms still show the simulator's figures.

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
  - Alpaca's SIP plan, if it's used;
  - OPRA, for options.
- **Modeled option quotes.** The modeled option quotes (`modelOptionQuote`) are estimates. They must not be shown as quotes.

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
- OCC's assignment process.

## Code still to do

With `BROKER=alpaca`, the app reads accounts only through the `Broker` interface: `lib/server/brokerLedger.ts`, used by `lib/server/portfolio.ts` and the account, lots, tax, order and transfer routes. The simulator's own background jobs are skipped (`simOnly` in `lib/server/jobs.ts`).

`BROKER_LEDGER=broker` makes the app read the simulator the same way. The scenario suite compares both paths on the same account, and they agree. What's left:
- **Figures Alpaca doesn't report.** These show as zero or nothing:
  - buying power held for open orders (`reservedCash`), accrued margin interest, margin calls (`marginCalls`, `marginStatus`, so no margin call banner or notifications), and liquidation fills;
  - why an order ended, which comes only with its trade event;
  - instant deposit credit.

  The margin rate shown is `ALPACA_MARGIN_RATE`. Margin calls could come from Alpaca's account events or reports, once their shape is known.
- **Lots and the gains report** come from replaying Alpaca's fills FIFO, with the splits stored from Alpha Vantage. Mergers, spinoffs, symbol changes and option exercises, assignments and expirations aren't replayed. After one of these the lots are approximate; Alpaca's 1099 is the record.
- **Locates.** The broker refuses them (501), so the order ticket shows no locate quote for a hard-to-borrow stock, and its Locate button fails with that message. Decide how hard-to-borrow shorts work with Alpaca, and hide the button accordingly.
- **Funding terms.** `GET /api/funding` still shows the simulator's limits and fees, except instant credit (none). Replace them once Alpaca's are confirmed.
- **Plaid Link.** `BankLink` loads Plaid Link only when `GET /api/funding` says Plaid is available, which needs `BROKER=alpaca` and Plaid's keys. It hasn't been tried against Plaid's sandbox.
- **Cost.** Each account page load reads the account's whole activity history (Alpaca pages it 100 at a time). It's kept 5 seconds and dropped after every change and broker event. A long history would want a stored copy, kept current from the NTA and trade streams.
