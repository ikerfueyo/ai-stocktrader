"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import OpenOrders from "./OpenOrders";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { describePlacedOrder, formatCurrency, formatPrice } from "@/lib/orders";
import { contractName, daysToExpiration, OPTIONS_LEVELS } from "@/lib/options";
import type { AppOrder, OptionChainContract, OptionChainResponse } from "@/lib/types";

type Side = "buy" | "sell";

interface SpreadLeg {
    contract: OptionChainContract;
    side: Side;
    ratio: number;
}

// The strikes shown around the stock's price, each way, until "All strikes"
const NEAR_STRIKES = 8;
const MAX_LEGS = 4;

const tickFor = (price: number) => price < 3 ? 0.01 : 0.05;
const roundToTick = (price: number) => {
    const tick = tickFor(price);
    return Math.round(Math.round(price / tick) * tick * 100) / 100;
};
const expirationLabel = (expiration: string, today: string) => {
    const date = new Date(`${expiration}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return `${date} (${daysToExpiration(expiration, today)}d)`;
};
const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

// The Trading page's options: the stock's chain for an expiration (calls, strikes, puts: bid, ask, implied volatility and delta, in the
// money shaded), an order ticket for one contract, and a spread builder for mleg orders of 2 to 4 legs. Quotes are Alpha Vantage's
// realtime ones when the plan has them, else modeled from the last close. Collapsed until opened, since a chain is a large download.
const OptionsPanel = ({ ticker }: { ticker: string }) => {
    const { account, refreshAccount } = useAccount();
    const [open, setOpen] = useState(false);
    const [expiration, setExpiration] = useState<string | null>(null);
    const [chain, setChain] = useState<OptionChainResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [allStrikes, setAllStrikes] = useState(false);
    const [selected, setSelected] = useState<{ contract: OptionChainContract; side: Side } | null>(null);
    const [legs, setLegs] = useState<SpreadLeg[]>([]);
    const [ordersVersion, setOrdersVersion] = useState(0);

    useEffect(() => {
        if (!open) return;
        const load = async () => {
            try {
                setChain((await axios.get<OptionChainResponse>(`/api/options/${ticker}${expiration ? `?expiration=${expiration}` : ""}`)).data);
                setError(null);
            } catch (error) {
                logError(error);
                setError(apiErrorMessage(error));
            }
        };
        load();
    }, [open, ticker, expiration]);

    const rows = useMemo(() => {
        if (!chain) return [];
        const strikes = [...new Set(chain.contracts.map(({ strike }) => strike))].sort((a, b) => a - b);
        const nearest = strikes.reduce((best, strike, index) => Math.abs(strike - chain.underlying.price) < Math.abs(strikes[best] - chain.underlying.price) ? index : best, 0);
        const shown = allStrikes ? strikes : strikes.slice(Math.max(0, nearest - NEAR_STRIKES), nearest + NEAR_STRIKES + 1);
        return shown.map(strike => ({
            strike,
            call: chain.contracts.find(contract => contract.strike === strike && contract.type === "call") ?? null,
            put: chain.contracts.find(contract => contract.strike === strike && contract.type === "put") ?? null
        }));
    }, [chain, allStrikes]);

    const placed = () => {
        refreshAccount();
        setOrdersVersion(version => version + 1);
    };

    const addLeg = (contract: OptionChainContract, side: Side) => {
        setLegs(current => current.some(leg => leg.contract.symbol === contract.symbol) || current.length >= MAX_LEGS ? current : [...current, { contract, side, ratio: 1 }]);
    };

    const level = account?.optionsLevel ?? 0;

    const quoteCell = (contract: OptionChainContract | null, field: "bid" | "ask") => {
        if (!contract) return <td className="text-muted">—</td>;
        const side: Side = field === "ask" ? "buy" : "sell";
        const active = selected?.contract.symbol === contract.symbol && selected.side === side;
        return (
            <td>
                <button type="button" className={`chain-quote ${field} ${active ? "active" : ""}`} onClick={() => setSelected({ contract, side })}
                    title={`${side === "buy" ? "Buy" : "Sell"} ${contractName(contract.symbol)} at about ${formatPrice(contract[field])}`}>
                    {contract[field].toFixed(2)}
                </button>
            </td>
        );
    };

    return (
        <div className="options-panel">
            <button type="button" className="options-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? "▾" : "▸"} Options
            </button>
            {open && (error ? <p className="text-danger">Couldn&apos;t load {ticker}&apos;s options: {error}</p> : !chain ? <p>Loading the option chain...</p> : (
                <Fragment>
                    <div className="options-toolbar">
                        <label>
                            Expiration
                            <select className="form-control form-control-sm" value={chain.expiration} onChange={event => { setExpiration(event.target.value); setSelected(null); }}>
                                {chain.expirations.map(date => <option key={date} value={date}>{expirationLabel(date, chain.today)}</option>)}
                            </select>
                        </label>
                        <label className="automation-check">
                            <input type="checkbox" checked={allStrikes} onChange={event => setAllStrikes(event.target.checked)} /> All strikes
                        </label>
                        <span className="options-level">
                            {OPTIONS_LEVELS[level]}{level < 3 && <Fragment> · <Link href="/settings">{level === 0 ? "Request options trading" : "Request a higher level"}</Link></Fragment>}
                        </span>
                    </div>
                    <p className="options-source">
                        {chain.source === "realtime"
                            ? "Realtime option quotes."
                            : `Quotes modeled from the ${chain.asOf} close, moved with ${ticker}'s price at each contract's implied volatility (realtime options aren't in this data plan).`}
                        {" "}Click a bid to sell or an ask to buy; one contract is 100 shares.
                    </p>
                    <div className="option-chain-wrapper">
                        <table className="table table-sm option-chain">
                            <thead>
                                <tr><th colSpan={4} className="chain-side">Calls</th><th /><th colSpan={4} className="chain-side">Puts</th></tr>
                                <tr><th>Δ</th><th>IV</th><th>Bid</th><th>Ask</th><th>Strike</th><th>Bid</th><th>Ask</th><th>IV</th><th>Δ</th></tr>
                            </thead>
                            <tbody>
                                {rows.map(({ strike, call, put }) => (
                                    <tr key={strike}>
                                        <td className={strike < chain.underlying.price ? "itm" : ""}>{call ? call.delta.toFixed(2) : "—"}</td>
                                        <td className={strike < chain.underlying.price ? "itm" : ""}>{call ? percent(call.impliedVolatility) : "—"}</td>
                                        {quoteCell(call, "bid")}
                                        {quoteCell(call, "ask")}
                                        <th scope="row" className="chain-strike">{strike}</th>
                                        {quoteCell(put, "bid")}
                                        {quoteCell(put, "ask")}
                                        <td className={strike > chain.underlying.price ? "itm" : ""}>{put ? percent(put.impliedVolatility) : "—"}</td>
                                        <td className={strike > chain.underlying.price ? "itm" : ""}>{put ? put.delta.toFixed(2) : "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {selected && (
                        <OptionTicket key={`${selected.contract.symbol}-${selected.side}`} contract={selected.contract} initialSide={selected.side}
                            optionsBuyingPower={account?.optionsBuyingPower ?? 0} onPlaced={placed} onAddLeg={addLeg} onClose={() => setSelected(null)} />
                    )}
                    {legs.length > 0 && <SpreadBuilder key={legs.map(({ contract, side, ratio }) => `${contract.symbol}${side}${ratio}`).join("|")} legs={legs} setLegs={setLegs} onPlaced={placed} />}
                    <OpenOrders ticker={undefined} optionsOf={ticker} refreshKey={ordersVersion} />
                </Fragment>
            ))}
        </div>
    );
};

interface TicketProps {
    contract: OptionChainContract;
    initialSide: Side;
    optionsBuyingPower: number;
    onPlaced: () => void;
    onAddLeg: (contract: OptionChainContract, side: Side) => void;
    onClose: () => void;
}

// One contract's order: buy or sell, whole contracts, market or limit (by the contract's tick), day or until cancelled. The broker
// works out whether it opens or closes a position, and checks the level and options buying power.
const OptionTicket = ({ contract, initialSide, optionsBuyingPower, onPlaced, onAddLeg, onClose }: TicketProps) => {
    const [side, setSide] = useState<Side>(initialSide);
    const [qty, setQty] = useState(1);
    const [type, setType] = useState<"market" | "limit">("limit");
    const [limit, setLimit] = useState(() => roundToTick(initialSide === "buy" ? contract.ask : contract.bid || contract.mark));
    const [timeInForce, setTimeInForce] = useState<"day" | "gtc">("day");
    const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const price = type === "limit" ? limit : side === "buy" ? contract.ask : contract.bid;
    const premium = price * 100 * qty;

    const submit = async () => {
        setSubmitting(true);
        setStatus(null);
        try {
            const { data } = await axios.post<AppOrder>("/api/orders", {
                symbol: contract.symbol, side, type, time_in_force: timeInForce, qty: String(qty), ...(type === "limit" ? { limit_price: limit.toFixed(2) } : {}),
                client_order_id: crypto.randomUUID()
            });
            setStatus(describePlacedOrder(data));
            onPlaced();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: apiErrorMessage(error) });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="option-ticket">
            <div className="option-ticket-header">
                <strong>{contractName(contract.symbol)}</strong>
                <span className="text-muted">bid {formatPrice(contract.bid)} · ask {formatPrice(contract.ask)} · Δ {contract.delta.toFixed(2)} · IV {percent(contract.impliedVolatility)}{contract.openInterest !== null ? ` · OI ${contract.openInterest.toLocaleString("en-US")}` : ""}</span>
                <button type="button" className="btn btn-sm btn-link" onClick={onClose} aria-label="Close the ticket">×</button>
            </div>
            <div className="order-entry">
                <select className="form-control form-control-sm" value={side} aria-label="Side" onChange={event => setSide(event.target.value as Side)}>
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                </select>
                <label>Contracts <QuantityStepper value={qty} setValue={setQty} decimals={0} /></label>
                <select className="form-control form-control-sm" value={type} aria-label="Order type" onChange={event => setType(event.target.value as "market" | "limit")}>
                    <option value="limit">Limit</option>
                    <option value="market">Market</option>
                </select>
                {type === "limit" && <label>Limit <QuantityStepper value={limit} setValue={value => setLimit(roundToTick(value))} decimals={2} prefix="$" /></label>}
                <select className="form-control form-control-sm" value={timeInForce} aria-label="Good for" onChange={event => setTimeInForce(event.target.value as "day" | "gtc")}>
                    <option value="day">Day</option>
                    <option value="gtc">Until cancelled</option>
                </select>
            </div>
            <p className="order-preview">
                {side === "buy" ? "Pays" : "Receives"} about {formatCurrency(premium)} ({formatPrice(price)} × 100 × {qty}) plus regulatory fees; options buying power {formatCurrency(optionsBuyingPower)}.
                {side === "sell" && " Selling to open needs the shares (a covered call), the cash for the strike (a cash-secured put), or a long contract that covers it."}
            </p>
            <div className="order-actions">
                <button type="button" className={side === "buy" ? "buy-btn" : "sell-btn"} onClick={submit} disabled={submitting || !(qty >= 1) || (type === "limit" && !(limit > 0))}>
                    {submitting ? "Placing..." : `${side === "buy" ? "Buy" : "Sell"} ${qty} contract${qty === 1 ? "" : "s"}`}
                </button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onAddLeg(contract, side)}>Add to spread</button>
            </div>
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </div>
    );
};

// An mleg order of 2 to 4 legs (one underlying), filled all together: each leg buys or sells ratio contracts per spread, and the net
// price is the buys at the ask less the sells at the bid (a debit, or a credit); a limit order fills when it's at or better than that
const SpreadBuilder = ({ legs, setLegs, onPlaced }: { legs: SpreadLeg[]; setLegs: (legs: SpreadLeg[]) => void; onPlaced: () => void }) => {
    const [qty, setQty] = useState(1);
    const [type, setType] = useState<"market" | "limit">("limit");
    const net = Math.round(legs.reduce((sum, leg) => sum + leg.ratio * (leg.side === "buy" ? leg.contract.ask : -leg.contract.bid), 0) * 100) / 100;
    const [limit, setLimit] = useState(Math.abs(net));
    const [direction, setDirection] = useState<"debit" | "credit">(net >= 0 ? "debit" : "credit");
    const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const update = (index: number, changes: Partial<SpreadLeg>) => setLegs(legs.map((leg, i) => i === index ? { ...leg, ...changes } : leg));

    const submit = async () => {
        setSubmitting(true);
        setStatus(null);
        try {
            const { data } = await axios.post<AppOrder>("/api/orders", {
                order_class: "mleg", qty: String(qty), type, time_in_force: "day",
                ...(type === "limit" ? { limit_price: (direction === "debit" ? limit : -limit).toFixed(2) } : {}),
                legs: legs.map(({ contract, side, ratio }) => ({ symbol: contract.symbol, side, ratio_qty: String(ratio) })),
                client_order_id: crypto.randomUUID()
            });
            setStatus(describePlacedOrder(data));
            if (data.status === "filled" || data.status === "new" || data.status === "accepted") setLegs([]);
            onPlaced();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: apiErrorMessage(error) });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="option-ticket spread-builder">
            <div className="option-ticket-header">
                <strong>Spread ({legs.length} leg{legs.length === 1 ? "" : "s"})</strong>
                <span className="text-muted">Now about {formatPrice(Math.abs(net))} {net >= 0 ? "debit" : "credit"} per spread ({formatCurrency(Math.abs(net) * 100 * qty)})</span>
                <button type="button" className="btn btn-sm btn-link" onClick={() => setLegs([])}>Clear</button>
            </div>
            <table className="table table-sm spread-legs">
                <tbody>
                    {legs.map((leg, index) => (
                        <tr key={leg.contract.symbol}>
                            <td>
                                <select className="form-control form-control-sm" value={leg.side} aria-label="Side" onChange={event => update(index, { side: event.target.value as Side })}>
                                    <option value="buy">Buy</option>
                                    <option value="sell">Sell</option>
                                </select>
                            </td>
                            <td><QuantityStepper value={leg.ratio} setValue={ratio => update(index, { ratio: Math.max(1, Math.round(ratio)) })} decimals={0} /></td>
                            <td>{contractName(leg.contract.symbol)}</td>
                            <td className="text-muted">{formatPrice(leg.side === "buy" ? leg.contract.ask : leg.contract.bid)}</td>
                            <td><button type="button" className="btn btn-sm btn-link text-danger" onClick={() => setLegs(legs.filter((_, i) => i !== index))}>Remove</button></td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {legs.length < 2 ? <p className="text-muted small">Add another contract from the chain (its ticket&apos;s Add to spread) to make a spread.</p> : (
                <Fragment>
                    <div className="order-entry">
                        <label>Spreads <QuantityStepper value={qty} setValue={setQty} decimals={0} /></label>
                        <select className="form-control form-control-sm" value={type} aria-label="Order type" onChange={event => setType(event.target.value as "market" | "limit")}>
                            <option value="limit">Limit</option>
                            <option value="market">Market</option>
                        </select>
                        {type === "limit" && (
                            <Fragment>
                                <label>Net <QuantityStepper value={limit} setValue={value => setLimit(Math.round(value * 100) / 100)} decimals={2} prefix="$" /></label>
                                <select className="form-control form-control-sm" value={direction} aria-label="Debit or credit" onChange={event => setDirection(event.target.value as "debit" | "credit")}>
                                    <option value="debit">Debit (you pay at most)</option>
                                    <option value="credit">Credit (you receive at least)</option>
                                </select>
                            </Fragment>
                        )}
                    </div>
                    <p className="order-preview">Every short leg the spread opens must be covered by a long leg of the same type in it, expiring no sooner (level 3). The legs fill together or not at all.</p>
                    <button type="button" className="buy-btn" onClick={submit} disabled={submitting || !(qty >= 1)}>{submitting ? "Placing..." : "Place spread"}</button>
                </Fragment>
            )}
            {status && <p className={status.ok ? "text-success" : "text-danger"}>{status.message}</p>}
        </div>
    );
};

export default OptionsPanel;
