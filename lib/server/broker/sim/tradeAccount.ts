// The simulator's trading account and positions in Alpaca's shapes (GET /v1/trading/accounts/{id}/account and /positions). Pure,
// so the tests can check them against the spec. Until margin arrives (Phase 5), buying power and the margin figures come from the
// app's cash-collateral model (lib/server/account.ts's valueAccount): no borrowing, 150% of the shorts held as collateral.
import type { AccountConfigurations, Position as AlpacaPosition, TradeAccount } from "../types";
import type { Position } from "../../../types";

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
const decimal = (value: number) => String(Math.round(value * 1e6) / 1e6);

export interface TradeAccountInput {
    account: {
        id: string; account_number: string; status: string; created_at: Date; trading_blocked: boolean; transfers_blocked: boolean;
        account_blocked: boolean; configurations: AccountConfigurations; options_approved_level: number; hasMarginAgreement: boolean;
    };
    // The ledger's cash (every activity's net amount), before queued withdrawals leave it
    cash: number;
    longMarketValue: number;
    // Positive: what it would cost to buy back the shorts
    shortMarketValue: number;
    // From valueAccount: what's available for new positions, and the shorts' collateral requirement and buy-in level
    buyingPower: number;
    initialMargin: number;
    maintenanceMargin: number;
    withdrawable: number;
    accruedFees: { REG: number; TAF: number; CAT: number };
    pendingTransferOut: number;
    // The last end-of-day snapshot (null before the first)
    last: { date: string; equity: number; cash: number; longMarketValue: number; shortMarketValue: number; maintenanceMargin: number } | null;
}

export const toTradeAccount = (input: TradeAccountInput): TradeAccount => {
    const { account, cash, longMarketValue, shortMarketValue } = input;
    const equity = cash + longMarketValue - shortMarketValue;
    const accrued = input.accruedFees.REG + input.accruedFees.TAF + input.accruedFees.CAT;
    const shortingEnabled = account.hasMarginAgreement && !account.configurations.no_shorting;
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
        buying_power: money(input.buyingPower),
        regt_buying_power: money(input.buyingPower),
        effective_buying_power: money(input.buyingPower),
        non_marginable_buying_power: money(input.buyingPower),
        options_buying_power: money(input.buyingPower),
        accrued_fees: money(accrued),
        pending_reg_taf_fees: money(input.accruedFees.REG + input.accruedFees.TAF),
        equity: money(equity),
        portfolio_value: money(equity),
        long_market_value: money(longMarketValue),
        // Alpaca reports the shorts' market value as negative
        short_market_value: money(-shortMarketValue),
        position_market_value: money(longMarketValue - shortMarketValue),
        initial_margin: money(input.initialMargin),
        maintenance_margin: money(input.maintenanceMargin),
        sma: "0",
        // Margin is Phase 5; every account is 1x until then, whatever its configuration allows
        multiplier: "1",
        shorting_enabled: shortingEnabled,
        options_approved_level: account.options_approved_level as TradeAccount["options_approved_level"],
        options_trading_level: (account.configurations.max_options_trading_level ?? 0) as TradeAccount["options_trading_level"],
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
        last_maintenance_margin: money(input.last?.maintenanceMargin ?? input.maintenanceMargin),
        last_buying_power: money(input.buyingPower),
        last_regt_buying_power: money(input.buyingPower)
    } as TradeAccount;
};

// A position as Alpaca returns it, from the lots' position, its asset and quote (price null without a current one: valued at cost)
export const toAlpacaPosition = (position: Position, asset: { id: string; exchange: string; marginable: boolean }, quote: { price: number | null; previousClose: number | null }): AlpacaPosition => {
    const qty = Math.abs(position.quantity);
    const sign = position.quantity < 0 ? -1 : 1;
    const price = quote.price ?? position.avgCost;
    const lastday = quote.previousClose ?? price;
    const costBasis = sign * qty * position.avgCost;
    const marketValue = sign * qty * price;
    const unrealized = marketValue - costBasis;
    const intraday = sign * qty * (price - lastday);
    return {
        asset_id: asset.id,
        symbol: position.ticker,
        exchange: asset.exchange,
        asset_class: "us_equity",
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
        unrealized_intraday_plpc: decimal(lastday > 0 ? intraday / (qty * lastday) : 0),
        current_price: decimal(price),
        lastday_price: decimal(lastday),
        change_today: decimal(lastday > 0 ? price / lastday - 1 : 0)
    };
};
