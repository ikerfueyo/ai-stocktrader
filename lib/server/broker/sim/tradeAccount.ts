// The simulator's trading account and positions in Alpaca's shapes (GET /v1/trading/accounts/{id}/account and /positions). Pure,
// so the tests can check them against the spec. The margin figures come from ./margin.ts's computeMargin.
import type { AccountConfigurations, Position as AlpacaPosition, TradeAccount } from "../types";
import type { Position } from "../../../types";
import type { MarginState } from "./margin";
import { contractMultiplier } from "../../../options";

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
const decimal = (value: number) => String(Math.round(value * 1e6) / 1e6);

export interface TradeAccountInput {
    account: {
        id: string; account_number: string; status: string; created_at: Date; trading_blocked: boolean; transfers_blocked: boolean;
        account_blocked: boolean; configurations: AccountConfigurations; options_approved_level: number; hasMarginAgreement: boolean;
    };
    // The margin figures, with cash as the ledger's (every activity's net amount), before queued withdrawals leave it
    state: Pick<MarginState, "cash" | "longMarketValue" | "shortMarketValue" | "buyingPower" | "regtBuyingPower" | "nonMarginableBuyingPower" | "initialMargin" | "maintenanceMargin" | "sma">;
    multiplier: number;
    shortingEnabled: boolean;
    withdrawable: number;
    accruedFees: { REG: number; TAF: number; CAT: number; ORF?: number; OCC?: number };
    pendingTransferOut: number;
    // The last end-of-day snapshot (null before the first; its margin figures null before Phase 5's)
    last: {
        date: string; equity: number; cash: number; longMarketValue: number; shortMarketValue: number; maintenanceMargin: number;
        initialMargin?: number | null; buyingPower?: number | null; regtBuyingPower?: number | null;
    } | null;
}

export const toTradeAccount = (input: TradeAccountInput): TradeAccount => {
    const { account, state } = input;
    const { cash, longMarketValue, shortMarketValue } = state;
    const equity = cash + longMarketValue - shortMarketValue;
    const accrued = input.accruedFees.REG + input.accruedFees.TAF + input.accruedFees.CAT + (input.accruedFees.ORF ?? 0) + (input.accruedFees.OCC ?? 0);
    return {
        id: account.id,
        account_number: account.account_number,
        status: account.status as TradeAccount["status"],
        crypto_status: "INACTIVE",
        currency: "USD",
        created_at: account.created_at.toISOString(),
        cash: money(cash),
        cash_withdrawable: money(input.withdrawable),
        cash_transferable: money(input.withdrawable),
        pending_transfer_out: money(input.pendingTransferOut),
        buying_power: money(state.buyingPower),
        regt_buying_power: money(state.regtBuyingPower),
        effective_buying_power: money(state.buyingPower),
        non_marginable_buying_power: money(state.nonMarginableBuyingPower),
        options_buying_power: money(state.nonMarginableBuyingPower),
        accrued_fees: money(accrued),
        pending_reg_taf_fees: money(input.accruedFees.REG + input.accruedFees.TAF),
        equity: money(equity),
        portfolio_value: money(equity),
        long_market_value: money(longMarketValue),
        // Alpaca reports the shorts' market value as negative
        short_market_value: money(-shortMarketValue),
        position_market_value: money(longMarketValue - shortMarketValue),
        initial_margin: money(state.initialMargin),
        maintenance_margin: money(state.maintenanceMargin),
        sma: money(state.sma),
        multiplier: String(input.multiplier),
        shorting_enabled: input.shortingEnabled,
        options_approved_level: account.options_approved_level as TradeAccount["options_approved_level"],
        // The effective level: the lower of the approved one and the account's own maximum
        options_trading_level: Math.min(account.options_approved_level, account.configurations.max_options_trading_level ?? 0) as TradeAccount["options_trading_level"],
        trading_blocked: account.trading_blocked,
        transfers_blocked: account.transfers_blocked,
        account_blocked: account.account_blocked,
        trade_suspended_by_user: account.configurations.suspend_trade ?? false,
        admin_configurations: {},
        balance_asof: input.last?.date ?? account.created_at.toISOString().slice(0, 10),
        last_equity: money(input.last?.equity ?? equity),
        last_cash: money(input.last?.cash ?? cash),
        last_long_market_value: money(input.last?.longMarketValue ?? longMarketValue),
        last_short_market_value: money(-(input.last?.shortMarketValue ?? shortMarketValue)),
        last_maintenance_margin: money(input.last?.maintenanceMargin ?? state.maintenanceMargin),
        last_initial_margin: money(input.last?.initialMargin ?? state.initialMargin),
        last_buying_power: money(input.last?.buyingPower ?? state.buyingPower),
        last_regt_buying_power: money(input.last?.regtBuyingPower ?? state.regtBuyingPower)
    } as TradeAccount;
};

// A position as Alpaca returns it, from the lots' position, its asset and quote (price null without a current one: valued at cost)
// (an option's quantity in contracts, its prices per share and its values × 100)
export const toAlpacaPosition = (position: Position, asset: { id: string; exchange: string; marginable: boolean }, quote: { price: number | null; previousClose: number | null }): AlpacaPosition => {
    const qty = Math.abs(position.quantity);
    const sign = position.quantity < 0 ? -1 : 1;
    const multiplier = contractMultiplier(position.ticker);
    const price = quote.price ?? position.avgCost;
    const lastday = quote.previousClose ?? price;
    const costBasis = sign * qty * position.avgCost * multiplier;
    const marketValue = sign * qty * price * multiplier;
    const unrealized = marketValue - costBasis;
    const intraday = sign * qty * (price - lastday) * multiplier;
    return {
        asset_id: asset.id,
        symbol: position.ticker,
        exchange: asset.exchange,
        asset_class: multiplier > 1 ? "us_option" : "us_equity",
        asset_marginable: asset.marginable,
        qty: decimal(sign * qty),
        qty_available: decimal(sign * qty),
        side: sign < 0 ? "short" : "long",
        avg_entry_price: decimal(position.avgCost),
        cost_basis: money(costBasis),
        market_value: money(marketValue),
        unrealized_pl: money(unrealized),
        unrealized_plpc: decimal(costBasis !== 0 ? unrealized / Math.abs(costBasis) : 0),
        unrealized_intraday_pl: money(intraday),
        unrealized_intraday_plpc: decimal(lastday > 0 ? intraday / (qty * lastday * multiplier) : 0),
        current_price: decimal(price),
        lastday_price: decimal(lastday),
        change_today: decimal(lastday > 0 ? price / lastday - 1 : 0)
    };
};
