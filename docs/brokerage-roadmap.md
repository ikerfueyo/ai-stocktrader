# AI StockTrader → Alpaca-compatible simulated brokerage

## Context

AI StockTrader prototypes what AI-assisted trading of U.S. stocks will look like. Before more AI work and a public deployment, it has to become two things:

1. **A complete trading platform** with what modern brokers offer, still simulated: no real trades and no real money.
2. **Alpaca-compatible**: it follows Alpaca's rules and U.S. regulations, and it can switch from simulation to the real Alpaca Broker API without restructuring.

Today the app is a self-invented mock:
- There are no accounts beyond a Clerk user ID, and no KYC.
- Cash movement is instant and fake (card, PayPal).
- Short collateral works on a 150%/130% model with instant buy-ins. There's no Reg T margin, no fees, no settlement and no tax lots (average cost only).
- There are only 4 order types, no extended hours, no replace, no partial fills, and positions are rebuilt by replaying trades.

**Decisions made:**
- Stocks only, no ETFs. SPY stays as a benchmark only.
- Extras to include: recurring buys and DRIP, price alerts, options, and IRAs.
- KYC fields are validated, and the SSN is stored as its last 4 digits only.
- **Alpha Vantage premium stays the primary data source** for everything it provides today: quotes for fills, daily and intraday bars, news with sentiment, overview, earnings, estimates, the earnings calendar, splits and dividends, search and market status. No AI inputs change.
- **Alpaca's free market data** (Basic plan, ready for SIP) is used only for what Alpha Vantage lacks: asset flags, the calendar and clock, bid/ask sizes, extended-hours quotes, mergers, spinoffs and symbol changes, and options chains when Alpha Vantage's options plan doesn't cover them.
- **The market-data layer is pluggable** per data type, so Alpaca (with SEC EDGAR for fundamentals) can replace Alpha Vantage later by configuration. Decide that later.
- All existing mock accounts are reset.

**Rule facts that changed recently**, from research on 2026-10-27:
- FINRA retired the pattern day trader rule on 2026-06-04 and replaced it with Rule 4210(d)(2) intraday margin. Alpaca removed `pattern_day_trader`, `daytrade_count` and `daytrading_buying_power` from its API. **We don't model the pattern day trader rule.**
- The SEC Section 31 fee is $20.60 per $1M of sales since 2026-04-04.
- The FINRA trading activity fee (TAF) is $0 from 2026-10-01 to 2026-12-31, then back to $0.000195 per share (max $9.79 per trade).

## Core architecture: the simulator *is* a broker

The app stops doing brokerage itself and talks to a `Broker` interface that mirrors Alpaca's Broker API one-to-one. There are two implementations:

- **`SimBroker`** (built now) re-implements Alpaca's behavior on Postgres: accounts and KYC, funding, the order engine, margin, settlement, fees, corporate actions, documents, options and IRAs.
- **`AlpacaBroker`** (built last; connected later) is a thin HTTP and server-sent-events (SSE) client using the same types.

`BROKER=sim|alpaca` picks one. Going live then means changing that setting, adding credentials, and swapping in the real pieces that only exist in a live setup (listed in "Going live" at the end).

```
app/api/**  ──►  lib/server/broker/index.ts  getBroker(): Broker
                    ├─ types.ts      Alpaca object shapes (generated from Alpaca's OpenAPI spec)
                    ├─ sim/          SimBroker: Postgres-backed engine + jobs
                    └─ alpaca/       AlpacaBroker: REST + SSE (last phase)
lib/server/marketData/  MarketData interface, one provider per data type (MARKET_DATA_<TYPE>=alphavantage|alpaca):
                        Alpha Vantage premium (default for everything it has) + Alpaca (asset flags, calendar/clock,
                        quote sizes, extended hours, other corporate actions, options fallback)
lib/server/features/    app-level features that work on either broker: recurring buys, DRIP, alerts, notifications
```

### Key rules for this architecture

- **Exact Alpaca shapes.** Vendor Alpaca's Broker API OpenAPI spec into `vendor/alpaca/` and generate the types with `openapi-typescript`. That means snake_case fields, and decimal amounts as strings, as Alpaca returns them.
  - The sim's responses are validated against that spec in the tests (`ajv`), so drift fails CI.
  - Errors follow Alpaca's shape (`{ code, message }`, with HTTP 403 for insufficient buying power and 422 for validation errors). `errorResponse` maps them to the app's existing error contract.
- **The broker is the source of truth.** Routes stop computing account math. They call `broker.getTradeAccount`, `listPositions`, `createOrder` and so on.
  - The app only previews things for UX: estimated cost, buying power shown, fees shown.
  - The broker enforces every rule, so a rule is never enforced only in the UI.
- **Events instead of polling.** The sim writes Alpaca-shaped events to `sim_events`, with ULID IDs ordered per account: trade updates, account status, transfer status and non-trade activities.
  - `broker.subscribe(handler, sinceUlid)` reads that table in sim mode and the SSE streams in Alpaca mode.
  - App features (notifications, DRIP, recurring buys) and the client (`AccountProvider` refresh) consume it, from a checkpoint stored in `event_checkpoints`.
- **Sim clock.** A `simClock` module drives every scheduled job:
  - end of day: fees, interest, margin calls, last-day snapshots;
  - beginning of day: settlement, confirmations;
  - monthly statements and the yearly tax run.
  - In development, `/api/dev/clock` (only when `NODE_ENV !== 'production'`) can run a job now, so T+1 settlement, call deadlines and expiries can be tested without waiting.
  - `MARKET_HOURS_OVERRIDE` and `PRICE_OVERRIDES` stay.
- **Account mapping.** New table `broker_accounts(user_id, broker, account_id, account_number, kind, created_at)`. One Clerk user can have an individual account plus a traditional and a Roth IRA, each a separate Alpaca account. `withUser` resolves the active account (from a header or cookie set by an account switcher). `withAccountLock` locks on the account ID instead of the user ID.
- **Pure core, thin I/O, as today.** Each rule set is a pure module with `node:test` tests (margin, fees, lots and wash sales, order validation and state machine, settlement calendar, KYC and transfer state machines). The Postgres engine only orchestrates them. Keep the current code style and the CLAUDE.md conventions, and update CLAUDE.md in every phase.

## Phases

Each phase leaves the app working, with `npm test`, `npm run typecheck` and `npm run lint` passing, and adds to CLAUDE.md. Phases 0–7 are the core. Phases 8–11 build on it.

### Phase 0: Foundations
- Vendor the Alpaca Broker API OpenAPI spec, generate `lib/server/broker/types.ts`, and add `ajv` conformance helpers.
- Define the `Broker` interface: accounts, configurations, assets, orders, positions, activities, ACH relationships and transfers, documents, portfolio history, options contracts and exercise, events.
- **A MarketData interface** (`lib/server/marketData/`) with one provider per data type. The default is Alpha Vantage premium for everything it serves today; move `lib/server/alphaVantage.ts` behind the interface unchanged, keeping its caches, request spacing and entitlement fallbacks.
  - An Alpaca client (`marketData/alpaca.ts`) follows the same patterns: `fetchAlpacaData` with request spacing under 200 calls a minute and `cachePromise`.
  - Env: `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` (a free Trading API account used for data only, with no orders or money), `ALPACA_DATA_FEED=iex|sip` and `ALPACA_OPTIONS_FEED=indicative|opra`.
  - `MARKET_DATA_<TYPE>` switches can later point any data type at Alpaca (with SEC EDGAR for fundamentals) without code changes.
- **What Alpaca adds** (Alpha Vantage has no equivalent):
  - From the Trading API: assets (Phase 0 universe), `/v2/calendar` (future holidays and early closes) and `/v2/clock`.
  - From stock snapshots: bid/ask sizes and the latest trade, merged into `Quote` alongside Alpha Vantage's price and bid/ask, plus extended-hours quotes for pre-market and after-hours trading.
  - Corporate actions Alpha Vantage lacks (mergers, spinoffs, symbol and CUSIP changes), for Phase 6.
  - Option chains if the Alpha Vantage plan doesn't include `REALTIME_OPTIONS`, for Phase 9.
  - The Basic plan's limits: real-time IEX only (about 2.5% of volume), 30 streaming symbols, 200 calls a minute. Add Alpaca's calls to the "Repo notes" cost section of CLAUDE.md.
- **Extended-hours data:** Alpha Vantage intraday with `extended_hours=true` for the 1D and 5D charts. Alpha Vantage's realtime quote for pre-market and after-hours prices, verifying it covers those sessions, otherwise Alpaca's.
- **New UI the data allows:** bid/ask sizes and last trade in `Price`, the extended-hours price and session, a home-page panel of top movers (Alpha Vantage `TOP_GAINERS_LOSERS`), a per-ticker news list (from `fetchTickerNews`), and earnings, estimates and analyst ratings in `QuoteDetails` (already fetched, today shown only to the AI).
- **Asset universe** in a `sim_assets` table, synced 3 times a day as Alpaca does:
  - From Alpaca's assets: `us_equity`, active, tradable, listed exchanges only (no OTC).
  - Intersected with Alpha Vantage `LISTING_STATUS` where `assetType=Stock`, so ETFs are excluded.
  - Keep Alpaca's flags: `marginable`, `shortable`, `borrow_status`, `fractionable`, `margin_requirement_long` and `margin_requirement_short`, and `attributes` such as `fractional_eh_enabled` and `has_options`.
  - Search, the Trading page, rankings (`mainTickers` filtering) and the watchlist only accept tickers in this universe.
- **Market sessions.** Replace the hard-coded calendar in `lib/marketHours.ts` with Alpaca's calendar, keeping the current lists as a fallback. Add the pre-market (4:00–9:30) and after-hours (16:00–20:00) sessions.
  - Overnight trading (20:00–4:00) stays off, as with `disable_overnight_trading`, until the data is verified: overnight data on the free plan is 15 minutes delayed.
- **Quote source for fills:** Alpha Vantage's realtime bulk bid/ask, as today. Alpaca's sizes limit how much fills at once (Phase 4's partial fills). Record the source with each fill (extend `fill_policy`).
- Add the sim clock and job runner, generalizing `lib/server/jobs.ts`: one advisory-locked leader, with named jobs for intraday matching, end of day, beginning of day, monthly and yearly runs.

### Phase 1: Accounts and onboarding (KYC)
- **Reset migration** `013_accounts.sql` (done; 012 became the asset universe):
  - Empties `orders`, `transactions` and `cash_activity`. They stay as tables, still used by the mock ledger, until Phase 3 replaces them; dropping them now would break trading for Phases 1–2.
  - Keeps `watchlist`, `verdict_log` and the corporate-action data.
  - Creates `broker_accounts`, `account_attestations` and the `sim_*` tables.
- **Account application** `/onboarding`, a multi-step wizard that builds Alpaca's `POST /v1/accounts` body:
  - `contact`: address lines, no P.O. boxes, `state` required for the USA.
  - `identity`: name, date of birth (18 or older), tax ID with `USA_SSN` or `USA_ITIN`, citizenship and U.S. residency only, `funding_source[]`, financial profile ranges, investment experience.
  - `disclosures`: employment, plus the four required booleans with `context[]` when one is true.
  - `trusted_contact`: optional.
  - `agreements[]`, each with `signed_at` and `ip_address`, captured on the server: customer, account, margin (if requested) and options (if requested).
  - W-9 certification, where the user certifies the tax ID and backup-withholding status.
  - Delivery of Form CRS and the privacy notice, recorded.
- **What gets stored.** The SSN is validated (format, and no 000, 666 or 9xx area for an SSN) and stored only as `•••-••-1234`. The form says to enter test data.
  - In sim mode, the agreements are placeholder simulator documents stating that no account is opened at any broker. Alpaca's real agreement links appear only when `BROKER=alpaca`.
- **KYC state machine** (pure), following Alpaca's statuses:
  - Path: `SUBMITTED` → `APPROVED` → `ACTIVE`, or `ACTION_REQUIRED` (document upload), `APPROVAL_PENDING` (approved after a delay) or `REJECTED`.
  - Deterministic test triggers decide the outcome, for example a family name of "ActionRequired" or "Reject".
  - Status changes emit account-status events.
- **Account gate.** `AppShell` sends signed-in users without an `ACTIVE` account to onboarding or a status page. Routes that trade or move money return 403 unless the account is `ACTIVE`, with no `trading_blocked`, `account_blocked` or `transfers_blocked` flag set.
- **Settings page** `/settings`:
  - Profile edits move the account to `ACCOUNT_UPDATED` (review, outgoing transfers paused) for the fields Alpaca lists.
  - Account configurations: `trade_confirm_email`, `no_shorting`, `max_margin_multiplier` (1, 2 or 4), `fractional_trading`, `suspend_trade`, `disable_overnight_trading`.
  - Upgrades: margin (with the margin agreement) and options level (with the options agreement and experience).
  - Trusted contact, documents uploaded for `ACTION_REQUIRED`, and closing the account (only with no positions and no cash).
- **Account switcher** in the header, for an individual account and IRAs (IRAs arrive in Phase 10).

### Phase 2: Funding (ACH, wires, settlement)
- Replace `TransferForm`'s card, Apple Pay, Google Pay and PayPal methods with a **linked bank (ACH relationship)**.
  - Fields: owner name (must match the account name, as Alpaca's Plaid check requires), checking or savings, routing number (keep `routingValid`), account number. Store only the last 4 digits and the routing number.
  - Statuses: `QUEUED` → `APPROVED` (or `REJECTED`), with **one active relationship per account**.
  - Drop the card helpers from `lib/payments.ts`.
- **Transfers** follow Alpaca's lifecycle: `QUEUED` → `SENT_TO_CLEARING` → `COMPLETE`, plus `CANCELED` (while queued) and `RETURNED`.
  - Timing is realistic: next business day by default, configurable with `SIM_ACH_SETTLEMENT_DAYS`, and driven by the sim clock.
  - Returns are simulated: test amounts trigger NACHA codes such as R01 (insufficient funds) and R10 (unauthorized), with a returned-ACH fee.
  - Each transfer posts `CSD`/`CSW` activities. `pending_transfer_out` comes off withdrawable cash right away.
- **Outgoing wire withdrawals** carry the fee from the fee schedule. Incoming wires aren't offered, as in Alpaca's API.
- **Instant funding** (done, configurable): up to $1,000 credited right away. Alpaca's activity types have no `MEM`, so it's the Transfer's `instant_amount`, posted as a `CSD` at once and the rest as a `CSD` when the deposit settles.
- **Limits are configurable** (`SIM_ACH_DAILY_LIMIT` and others), because Alpaca's production limits are set per partner. That still needs confirming.
- **Withdrawable cash** = `cash_withdrawable`: settled cash, minus unsettled sale proceeds, pending withdrawals and margin requirements. Withdrawals are blocked while there's a margin call or `ACCOUNT_UPDATED` is pending.
- UI: Transfers page with linked bank, transfer history with statuses, and cancel while queued.

### Phase 3: Ledger, positions, lots, settlement and fees
- **Ledger tables:**
  - `sim_activities`, one row per Alpaca activity. Trades are `FILL` rows with `qty`, `price`, `side`, `leaves_qty`, `cum_qty` and `order_id`. Non-trade activities (`CSD`, `CSW`, `FEE`, `INT`, `DIV`, `SPLIT` (the research said `SSP`; Alpaca's enum has `SPLIT`), `MA`, `OPASN`, `OPEXP`, `OPXRC`, `MEM`) carry `net_amount` and `per_share_amount`. Each row has a settle date.
  - `sim_positions`, updated in the same database transaction as the fill. Positions are no longer replayed on every request.
- **FIFO tax lots** in `sim_lots`: acquired date, quantity, cost and wash-sale adjustments.
  - `avg_entry_price` = the cost of the remaining lots divided by their quantity, so it differs from today's average cost after a partial sale.
  - Realized P&L is FIFO, short-term or long-term.
  - Adapt `computePositions`' split handling to lots.
- **Trade account object.** The pure `computeTradeAccount` builds every field in Alpaca's account object: `cash`, `cash_withdrawable`, `cash_transferable`, `buying_power`, `regt_buying_power`, `non_marginable_buying_power`, `equity`, `last_equity`, `long_market_value`, `short_market_value`, `initial_margin`, `maintenance_margin`, `last_maintenance_margin`, `sma`, `multiplier`, `accrued_fees`, `pending_transfer_out`, `pending_reg_taf_fees`, `shorting_enabled` and the blocked flags.
  - It replaces `valueAccount`. Keep the equity identities tested today (equity = net deposits + realized + unrealized + income − fees).
- **T+1 settlement** of fills, calculated on the trading calendar. Buying power includes unsettled proceeds, since Alpaca covers the float, but withdrawable cash doesn't.
- **Fee engine.** A pure, date-effective fee schedule in `sim/feeSchedule.ts`, with a source URL on every rate:
  - Commission $0.
  - SEC Section 31 fee on sale proceeds.
  - FINRA TAF per share sold, with its cap and its $0 window.
  - The consolidated audit trail (CAT) fee per share on buys and sells.
  - Fees accrue during the day and are deducted at the end of day, rounded up to the cent, as `FEE` activities.
  - Also wire, ACH-return and ADR fees.
  - **Before shipping**, check the numbers against Alpaca's fee schedule PDF (BrokFeeSched.pdf, dated 2026-10-12).
- **Jobs:**
  - End of day: deduct fees, snapshot `last_*`, store the daily equity snapshot.
  - Beginning of day: settle, release unsettled cash.
- **Portfolio history** comes from stored snapshots (Alpaca's `portfolio/history` shape). `lib/server/history.ts`'s time-weighted return then works on snapshots plus `CSD`/`CSW` activities.
- **UI:**
  - Portfolio: Alpaca positions (`qty_available`, cost basis, unrealized P&L, change today) and a lots drill-down.
  - Transactions page: an activities feed with type filters and CSV export.
  - Header: buying power and withdrawable cash replace "Available".

### Phase 4: Equity order engine (Alpaca semantics)
- Rewrite `orderMatching.ts` and `orders.ts` around Alpaca's order object:
  - UUID `id` and a unique `client_order_id` (idempotency).
  - `qty` or `notional`, `side`, `type` (market, limit, stop, stop_limit, trailing_stop), `time_in_force` (day, gtc, opg, cls, ioc, fok), `extended_hours`.
  - `order_class` (simple, bracket, oco, oto) with legs, plus `position_intent`.
  - Every timestamp field, `filled_qty` and `filled_avg_price`, `hwm`, and `replaces`/`replaced_by`.
  - Market orders become stored orders too (today they're inline in `app/api/trading/[ticker]/route.ts`), so there's one path for every order.
- **Validation** as a pure function with Alpaca's rule set and error codes:
  - Price increments: 2 decimals at $1.00 and above, 4 below.
  - Fractional and notional orders: day TIF only, at least $1, `qty` up to 9 decimals, no fractional shorts, notional orders can't be replaced.
  - Extended hours: limit orders with day or GTC TIF, no brackets; fractional only when the asset has `fractional_eh_enabled`.
  - OPG and CLS submission windows.
  - Bracket, OCO and OTO leg rules (stop at least $0.01 beyond the base price).
  - GTC orders expire after 90 days.
  - The asset must be tradable, and the account must allow trading.
- **State machine and events:**
  - Order statuses: `pending_new` → `new`/`accepted` → `partially_filled` → `filled`, `done_for_day`, `canceled`, `expired`, `replaced`, `pending_cancel`, `pending_replace`, `rejected`, and `held` for child legs.
  - Every transition emits a `trade_updates` event.
- **Matching:**
  - Fills at the NBBO with the existing ask/bid rules (`fillPrice`).
  - **Partial fills** use a liquidity model: each tick fills up to the displayed size, or a configurable share of recent 1-minute volume.
  - IOC and FOK orders are decided immediately.
  - OPG and CLS orders fill at the official open or close (the daily bar).
  - Trailing stops track the high-water mark (`hwm`) and only trigger in the regular session.
  - Bracket and OTO children activate when the parent fills. OCO cancels the other side.
  - The extended-hours sessions use extended-hours quotes.
  - The matching interval drops from 30s to about 5s while any order is open (rate limits permitting).
- **Replace** (PATCH) creates a new order that inherits the omitted fields, links `replaces`/`replaced_by`, and reserves the larger of the old and new orders while the replace is pending. **Cancel** goes through `pending_cancel`. Add cancel-all.
- **Buying-power reservation** for open orders follows Alpaca, for example a short sell is checked at qty × max(limit, ask × 1.03). This replaces `reservedForOrders`.
- **UI:** an order ticket with every type and TIF, an extended-hours toggle, bracket/OCO/OTO builders, a fee and buying-power preview, and modify/cancel in `OpenOrders`. Order details show a fill timeline. The Portfolio close button posts a `sell_to_close`/`buy_to_close` market order.

- **As built (done):** the engine is `lib/server/broker/sim/orders.ts`, with the pure rules in `orderRules.ts` and `matching.ts` (CLAUDE.md has the details). Where it differs from the plan above:
  - Partial fills are sized by a share of the average shares traded per minute so far today (`SIM_LIQUIDITY_SHARE`, at least a round lot), since the displayed size needs Alpaca keys. Fractional and notional orders fill in full.
  - Replacing a partially filled order isn't simulated (cancel it and submit the rest). Replace and cancel run synchronously, so `pending_replace` and `pending_cancel` only appear as events.
  - Buys are checked and reserved at their limit, stop or the ask (no buffer); short sales at the higher of the limit and 3% above the ask, under the cash-collateral model until Phase 5.
  - An order can't go through zero either way (a buy past a short is refused like a sell past a long).
  - Bracket and OTO legs report `held` until their entry fills, as Alpaca does, though the spec's `OrderStatus` enum leaves it out.
  - Orders don't carry why they ended; the routes add the simulator's `reason`, which Alpaca sends with the order's trade event.
  - The order engine runs every 5s (`SIM_ORDER_MATCH_MS`), outside the overnight close.

### Phase 5: Margin, shorting and calls (Reg T, FINRA 4210, Alpaca house rules)
- **Pure `margin.ts`:**
  - Below $2,000 equity, the multiplier is 1×.
  - At or above $2,000 with margin enabled: 2× overnight Reg T, and 4× intraday for leverage-enabled accounts, with positions back to 2× by the close.
  - Initial margin is 50% for marginable stocks and 100% for non-marginable ones.
  - House maintenance requirements:

    | Side | Condition | Requirement |
    |---|---|---|
    | Long | Below $2.50 | 100% |
    | Long | $2.50 to $6 | 50% |
    | Long | Above $6 | 30% |
    | Short | Below $5 | Greater of $2.50/share or 100% |
    | Short | $5 and above | Greater of $5.00/share or 30% |

  - Per-asset `margin_requirement_long` and `margin_requirement_short` override the table.
  - Concentration: maintenance rises to 50% when one stock is at least 70% of the market value and the margin balance is at least $100k.
  - Also calculates special memorandum account (SMA) and Reg T buying power.
- **Shorting:**
  - Needs a margin account, `shorting_enabled`, at least $2,000 of equity and `no_shorting` off.
  - The asset must be `shortable`.
  - Easy-to-borrow (ETB) shorts are free.
  - Hard-to-borrow (HTB) shorts need a **locate** first: round lots of 100, single use, with a non-refundable fee. They also pay a daily borrow fee (short value × rate / 360, with weekends counted). The rates are simulated and labeled.
  - Short dividends are charged.
- **Margin interest:** 6.50% a year on the overnight debit balance, debit × rate / 360 per day, posted monthly as `INT`. Make the rate configurable and verify it.
- **Calls, replacing `planBuyIn`, `enforceCollateral` and the 150%/130% rules:**
  - Maintenance call: the end-of-day deficiency is issued the next morning, with a configurable deadline. An unmet call is liquidated starting with the riskiest positions. Liquidation happens intraday right away below a severe threshold.
  - Reg T call: an initial-margin shortfall.
  - **Intraday margin deficit** under the new Rule 4210(d)(2): a single calculation on days with a trade that lowers the intraday margin level, a de minimis threshold (the lesser of 5% of equity or $1,000), a 5-business-day deadline (Alpaca's docs conflict between 2 and 5), and a 90-day restriction for repeated misses.
  - While a call is open, new opening trades are blocked. Liquidation trades are marked in the activity's description.
- **UI:** a margin panel (buying power types, maintenance, SMA, call status with deadline and amount due), a `MarginBanner` rewrite, a short ticket showing borrow status and the locate flow, and margin and short eligibility messages.

- **As built (done):** the rules are `lib/server/broker/sim/margin.ts`; the simulator runs them in `marginAccount.ts` (snapshot, buying power, withdrawals, the trading account), `calls.ts` (calls, liquidation, interest, borrow fees) and `locates.ts` (CLAUDE.md has the details). Where it differs from the plan above:
  - HTB shorts follow Alpaca's locate API (`/v1/locates`, in the Trading API): locates in round lots of 100, single use, with a non-refundable fee charged when granted, good until 8:00 p.m. ET. Fees, inventory and the borrow rate are simulated (`SIM_LOCATE_FEE_RATE`, `SIM_LOCATE_AVAILABLE`, `SIM_HTB_BORROW_RATE`). Without Alpaca's flags every stock is easy to borrow, so `SIM_HTB_SYMBOLS` marks some for testing.
  - Calls: maintenance and Reg T (the latter only after a day that opened positions, since a fall in prices doesn't call for initial margin), issued the morning after the close and due `SIM_MARGIN_CALL_DAYS` trading days later (default 2; Alpaca doesn't publish a deadline). Immediate liquidation below `SIM_LIQUIDATION_RATIO` of the maintenance requirement (default 0.75), Alpaca's "materially below". A call is met when the deficiency is gone or deposits since it was issued cover it.
  - Not modeled yet: the intraday margin deficit of FINRA Rule 4210(d)(2) (the 4x intraday buying power with the overnight Reg T call covers its effect), the 90-day restriction for repeated misses, and a running SMA (reported as the excess over Reg T initial margin).
  - Margin interest is 6.50% (the non-elite rate), on the settlement-date debit, and posts after the month's last trading day.

### Phase 6: Corporate actions
- Splits and dividends keep coming from Alpha Vantage `SPLITS`/`DIVIDENDS` (`lib/server/corporateActions.ts`). Mergers, spinoffs and symbol changes come from Alpaca's corporate-actions endpoint, all stored in `corporate_actions` (add the types).
- **Effects:**
  - Forward and reverse splits post `SPLIT` (done in Phase 3 for lots), adjust positions and lots, and keep fractional shares (cash in lieu is configurable).
  - Cash dividends post `DIV` on longs and a charge on shorts, on the payment date, for holders at the ex-date (keep `planDividends`'s logic).
  - Cash and stock mergers post `MA`. Spinoffs add a new position with a basis allocation. Symbol or CUSIP changes rename the asset. Delistings are handled too.
- **Orders, following Alpaca:** a reverse split cancels GTC orders. A forward split adjusts GTC buy-limit and sell-stop orders and cancels the others with `reason=CORPORATE_ACTION`. This replaces today's "cancel every order placed before a split".

- **As built (done):** the rules are `lib/server/broker/sim/corporateActions.ts`; `positions.ts` applies them to lots (`applyCorporateActions`) and `orders.ts` to orders (`processCorporateActionOrders`), with a daily `corporate-actions` job (CLAUDE.md has the details). Where it differs from the plan above:
  - Without Alpaca keys only Alpha Vantage's splits and cash dividends arrive; the other types need Alpaca's corporate actions API. Unit splits, redemptions and rights aren't stored (not for common stocks).
  - Following Alpaca's docs, bracket, OCO and OTO orders are do-not-reduce, do-not-cancel, so splits and dividends leave them as they are; mergers, symbol changes and worthless removals cancel every open order in the symbol. A spinoff cancels the source's other open orders, and a cash dividend lowers GTC buy limits and sell stops by its amount.
  - A symbol change renames the lots and posts no activity (Alpaca shows it through the asset); watchlists follow it. The app's asset universe catches up at its next sync, and until then a position in the new symbol can be closed but not added to.
  - Basis allocation for spinoffs and mixed mergers, and cash in lieu (off by default: Alpaca keeps fractional shares), use the quotes when the action is applied rather than the effective date's closes.
  - Delistings without a worthless removal leave the position as it is, closable through its symbol.

### Phase 7: Documents and tax
- **Documents** in Alpaca's document object shape (`id`, `type`, `date`, `name`, `sub_type`), rendered as printable HTML routes (`/documents/[id]`, downloadable as PDF through print). Alpaca mode proxies Alpaca's PDFs.
  - `trade_confirmation`: one per trading day, at the beginning of the next day, plus `trade_confirmation_json`.
  - `account_statement`: monthly, after the first weekend.
  - `account_application`: a copy of what was submitted, masked.
  - `tax_statement`: the consolidated 1099, available by Feb 15 for the previous year.
    - 1099-B: FIFO lots, short- and long-term, covered basis, and **wash sales within the account by symbol/CUSIP** (the disallowed loss added to the replacement lot).
    - 1099-DIV: all ordinary, since qualified status isn't available (a labeled limitation).
    - 1099-INT.
  - The development clock can generate "preliminary" versions.
- **Backup withholding:** 24% on dividends and proceeds while the W-9 certification is missing.
- **UI:** a Documents page (filters by type and year), a realized gains/losses report by tax year, and the unrealized lots view.

### Phase 8: Recurring buys, DRIP, alerts and notifications (app-level, work on either broker)
- **Recurring investments:** a ticker, an amount (notional), a schedule (daily, weekly, every two weeks or monthly), and a funding check. They place a day notional market order at the open through `broker.createOrder` with a `client_order_id` derived from the schedule and date, so each runs at most once. They pause when an order is rejected for buying power, and the user is notified.
- **DRIP:** set per account and per position. On each `DIV` event, place a notional buy for the net amount (fractionable assets only; at least $1, or accumulate).
- **Price alerts:** price crossing above or below a level, or a percentage change in the day, checked by the job against market data, firing once and then rearming optionally.
- **Notifications center:** a bell in the header, fed by broker events (fills, cancels, rejects, transfers, calls, corporate actions, documents) plus alerts, with per-type preferences. In-app and browser notifications only; email waits for deployment.

### Phase 9: Options (Alpaca levels 1–3)
- **Approval:** `max_options_trading_level` and `options_approved_level`, the options agreement and an experience questionnaire.
  - Level 1: covered calls and cash-secured puts.
  - Level 2: buying calls and puts.
  - Level 3: spreads (`mleg`).
- **Data:** contracts from Alpaca's options contracts endpoint. Quotes, Greeks and implied volatility from Alpha Vantage `REALTIME_OPTIONS` if the plan includes it. Otherwise Alpaca's option chain and snapshots: the indicative feed on Basic (labeled indicative), OPRA with `ALPACA_OPTIONS_FEED=opra`.
- **Engine:**
  - Option orders: market and limit, whole contracts, `position_intent` required; verify which TIFs Alpaca allows.
  - `mleg` multi-leg orders for level 3.
  - `options_buying_power`, with short options covered by stock or cash.
  - Options fees: verify Alpaca's options regulatory fee (ORF), OCC and TAF pass-throughs.
  - Expiration: in-the-money by $0.01 or more is exercised or assigned automatically (`OPEXP`, `OPASN`, `OPXRC`). Early assignment of short options is simulated around ex-dividend dates. Positions that can't be covered are closed on expiration day (verify Alpaca's cutoff time).
  - Manual exercise endpoint.
- **UI:** an option chain on the Trading page (expiry picker, calls and puts, Greeks), an option ticket and spread builder, option positions with days to expiration (DTE) and exercise, and options lines on 1099-B.

### Phase 10: IRAs (traditional and Roth)
- Verify Alpaca's IRA docs first (they appeared recently and their details aren't confirmed).
- **Account kind:** a separate account per IRA with its own application (beneficiaries, IRA agreement).
  - No shorting, no margin borrowing (multiplier 1), options limited to the levels Alpaca allows.
- **Contributions:** ACH transfers with an `ira` object (tax year, contribution type). Annual limits apply across both IRA kinds (configurable per year: verify the 2026 limit and the age-50 catch-up), and contributions for the previous year are allowed until the deadline.
- **Distributions:** with a reason code and federal/state withholding elections, plus an early-withdrawal flag.
- **Documents:** Form 5498 and 1099-R. The 1099-B doesn't apply inside an IRA.
- **UI:** the IRA in the account switcher, contribution progress against the limit, and a distribution request form.

### Phase 11: AlpacaBroker adapter (no live connection yet)
- Implement `lib/server/broker/alpaca/` against the same interface:
  - OAuth client credentials (`authx.alpaca.markets`, 15-minute tokens), REST calls, and SSE streams with a `since_ulid` checkpoint and deduplication.
  - Plaid processor tokens for ACH, with manual routing and account numbers as a fallback.
  - The full SSN passed straight through to Alpaca and never stored.
  - Real agreements and Form CRS links.
- **Shared scenario suite:** one set of scenarios (onboard, fund, buy, short, partial fill, replace, cancel, bracket, call, dividend, split, withdraw), written against `Broker`. It runs against `SimBroker` in CI, and against Alpaca's Broker API sandbox later, once you choose to connect.
- **`docs/going-live.md`** lists what remains, which isn't code: a broker partnership and Alpaca's review, Plaid production access, a securities and investment-adviser counsel review (the AI recommendations, especially the personalized position analysis), market-data redistribution licensing, security work (SOC 2, multi-factor sign-in with Clerk, re-authentication before withdrawals, Reg S-P incident response), and the data the simulator can't model.

## Files most affected
- **New:** `lib/server/broker/{index,types,errors}.ts`, `lib/server/broker/sim/**` (engine, state machines, `margin.ts`, `feeSchedule.ts`, `lots.ts`, `settlement.ts`, `kyc.ts`, `transfers.ts`, `orderValidation.ts`, jobs), `lib/server/marketData/**`, `lib/server/features/**`, `vendor/alpaca/*.json`, `db/migrations/012+`, new pages (`/onboarding`, `/settings`, `/documents`, `/transfers`, `/options`, `/recurring`, `/alerts`).
- **Rewritten:**
  - Every account and trading route: `app/api/{account,portfolio,trading,orders,transfers,transactions}/**`.
  - `lib/server/{orders,orderMatching,portfolio,upkeep,jobs,history,corporateActions}.ts`.
  - `components/{BuySellFunctionality,OpenOrders,PortfolioList,PortfolioRow,TransferForm,TransactionsList,AccountSummary,MarginBanner,Header}.tsx`, `context/AccountContext.tsx`, `lib/types.ts`.
- **Retired:** the 150%/130% collateral model (`SHORT_COLLATERAL_RATE`, `BUY_IN_RATE`, `planBuyIn`, `enforceCollateral`, `assessTrade`, `assessWithdrawal`), the card and PayPal methods, average cost, and replaying positions from the trade history.
- **Reused:**
  - `fillPrice`, `roundShares` and `toOrder` sizing (`lib/orders.ts`), `planDividends` and `positionsAt`.
  - Split math from `computePositions`.
  - `withAccountLock` and `inTransaction` (`lib/server/portfolio.ts`).
  - `cachePromise`/`singleton` (`lib/server/cache.ts`).
  - The `fetchAlphaVantage` request spacing, the `withUser`/`errorResponse` contract, `routingValid` (`lib/payments.ts`), and the job leader election (`lib/server/jobs.ts`).
- **Market data:** `lib/server/alphaVantage.ts` stays and moves behind the MarketData interface. The AI modules (`analysis.ts`, `earnings.ts`, `technicals.ts`, `trackRecord.ts`, `buildRankings`) keep all their inputs and logic, apart from the ticker universe.

## Verification
- **Pure-rule tests** (`node:test`, added to `npm test`) for each rule set:
  - margin and buying power, against worked examples from Alpaca's docs;
  - fee schedule dates and rounding;
  - FIFO lots and wash sales, against IRS Publication 550 examples;
  - the order-validation matrix, against Alpaca's documented rules;
  - order, KYC and transfer state machines;
  - the T+1 settlement calendar;
  - intraday-margin-deficit thresholds;
  - options expiration.
- **Keep or adapt the randomized invariant run** in `account.test.ts`: equity identities after random fills, fees and dividends.
- **Schema conformance:** every `SimBroker` response and event validates against the vendored Alpaca OpenAPI spec.
- **Scenario suite** against `SimBroker` with a seeded test database and the dev clock: onboard to `ACTIVE`, link a bank, deposit (settles next business day), buy, short an ETB stock, a partial fill, a replace, a bracket with OCO legs, an end-of-day fee deduction, a margin call and liquidation, a dividend, a split, a withdrawal limited to withdrawable cash, a recurring buy, DRIP, an alert, option expiration, an IRA contribution limit.
- **Manual pass in the app** (`npm run dev`, preview tools): run each phase's UI flows in the browser pane, with `MARKET_HOURS_OVERRIDE` and `PRICE_OVERRIDES` for deterministic prices, and screenshots as proof.
- **Each phase:** `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass.

## Open items to verify during implementation (not blockers)
- Alpaca's fee schedule PDF figures (wire, ACH-return, ACATS), the exact descriptions on `FEE` activities, and the current margin interest rate.
- Which agreements a U.S. individual account needs. The production ACH limits and cutoff times.
- The deadline for intraday-margin-deficit calls (2 or 5 days). The maintenance-call deadline.
- Whether the Alpha Vantage plan includes `REALTIME_OPTIONS` and extended-hours realtime quotes. Alpaca Basic's corporate-actions coverage. The options TIF rules and expiration cutoffs. Options ORF and OCC fees.
- The details of Alpaca's IRAs and the 2026 IRA contribution limits.
- The Section 31 rate once the FY2027 appropriation passes. The TAF resuming in Jan 2027.
