"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import BankLink from "./BankLink";
import { useFunding } from "./useFunding";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, roundCents } from "@/lib/orders";
import { formatEastern } from "@/lib/marketHours";
import { accountNumberValid, digitsOnly, routingValid } from "@/lib/payments";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import { distributionWithholding } from "@/lib/ira";
import type { BrokerTransfer, IraOverview, TransferRequest } from "@/lib/types";

type Direction = "deposit" | "withdraw";

const QUICK_AMOUNTS = [100, 500, 1000];
const DEFAULT_AMOUNT = 100;

const expected = (iso: string) => formatEastern(iso, { withDay: true });

// Deposit or withdraw money. Deposits come by ACH from the linked bank account (linked here first if there's none), with up to the
// instant limit credited at once. Withdrawals go by ACH to it (free, next banking day) or by wire to a recipient bank (with its fee,
// the same day), and only from withdrawable cash. In an IRA, a deposit is a contribution for a tax year (within what's left of the
// limit across the user's IRAs) and a withdrawal a distribution, with its reason and tax withholding.
const TransferForm = ({ direction }: { direction: Direction }) => {
    const { account, refreshAccount } = useAccount();
    const { active } = useBrokerAccount();
    const isIra = active?.kind === "traditional_ira" || active?.kind === "roth_ira";
    const [ira, setIra] = useState<IraOverview | null>(null);
    const [iraVersion, setIraVersion] = useState(0);
    const [taxYear, setTaxYear] = useState<number | null>(null);
    const [reason, setReason] = useState("");
    const [fedPct, setFedPct] = useState(10);
    const [statePct, setStatePct] = useState(0);
    useEffect(() => {
        if (!isIra) return;
        const load = async () => {
            try {
                setIra((await axios.get<IraOverview>("/api/ira")).data);
            } catch (error) {
                logError(error);
            }
        };
        load();
    }, [isIra, iraVersion]);
    const { accountId, relationships, approved, banks, holderName, terms, error: loadError, reload } = useFunding();
    const wireFee = terms?.wireFee ?? 0;
    const isDeposit = direction === "deposit";
    const [method, setMethod] = useState<"ach" | "wire">("ach");
    const [bankId, setBankId] = useState<string>("");
    const [newBank, setNewBank] = useState({ name: "", routing: "", account: "" });
    const [value, setValue] = useState(DEFAULT_AMOUNT);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

    const fee = !isDeposit && method === "wire" ? wireFee : 0;
    const withdrawable = account?.withdrawableCash ?? 0;
    const year = ira?.years.find(entry => entry.taxYear === taxYear) ?? ira?.years[0] ?? null;
    const reasons = ira?.account?.distributionReasons ?? [];
    const chosenReason = reasons.some(entry => entry.reason === reason) ? reason : reasons[0]?.reason ?? "";
    const withholding = (() => {
        try {
            return distributionWithholding(roundCents(value), { fedPct, statePct });
        } catch {
            return null;
        }
    })();
    // An IRA contribution is also capped at what's left of the year's limit
    const maxAmount = isDeposit ? Math.min(terms?.dailyAch ?? 0, isIra && year ? year.remaining : Infinity) : Math.max(0, roundCents(withdrawable - fee));
    const marginCall = account?.marginStatus !== undefined && account.marginStatus !== "ok";
    const chosenBank = method === "wire" ? (bankId || banks[0]?.id || "") : "";
    const addingBank = method === "wire" && !chosenBank;
    const newBankValid = newBank.name.trim() !== "" && routingValid(newBank.routing) && accountNumberValid(newBank.account);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!accountId) return;
        setSubmitting(true);
        setStatus(null);
        try {
            let recipient = chosenBank;
            if (addingBank) {
                const created = await axios.post<{ id: string }>(`/api/accounts/${accountId}/banks`, { name: newBank.name.trim(), bank_code: newBank.routing, account_number: newBank.account });
                recipient = created.data.id;
                setBankId(recipient);
                setNewBank({ name: "", routing: "", account: "" });
            }
            const transfer: TransferRequest["transfer"] = {
                type: isDeposit ? "ach" : method, direction: isDeposit ? "INCOMING" : "OUTGOING", amount: roundCents(value),
                ...(isDeposit || method === "ach" ? { relationshipId: approved?.id } : { bankId: recipient }),
                ...(isIra ? { ira: isDeposit ? { taxYear: year?.taxYear } : { distributionReason: chosenReason, fedPct, statePct } } : {})
            };
            const { data } = await axios.post<BrokerTransfer>(`/api/accounts/${accountId}/transfers`, { transfer } satisfies TransferRequest);
            const instant = Number(data.instant_amount ?? 0);
            setStatus({
                ok: true,
                message: isDeposit
                    ? `Deposit of ${formatCurrency(Number(data.amount))} requested. ${instant > 0 ? `${formatCurrency(instant)} is available to trade now; ` : ""}it settles by ${expected(data.expires_at!)}.`
                    : `Withdrawal of ${formatCurrency(Number(data.amount))} requested${fee > 0 ? ` (plus the ${formatCurrency(fee)} wire fee)` : ""}. It should arrive by ${expected(data.expires_at!)}.`
            });
            await Promise.all([refreshAccount(), reload()]);
            setIraVersion(version => version + 1);
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: apiErrorMessage(error) });
        } finally {
            setSubmitting(false);
        }
    };

    const needsBank = (isDeposit || method === "ach") && !approved;
    const iraReady = !isIra || (isDeposit ? year !== null : chosenReason !== "" && withholding !== null);
    const canSubmit = !submitting && value > 0 && value <= maxAmount && !needsBank && (!addingBank || newBankValid) && !(isDeposit ? false : marginCall) && iraReady;

    return (
        <div className="transfer-container mt-5">
            <h1 className="transfer-title">{isIra ? (isDeposit ? "Contribute" : "Take a distribution") : isDeposit ? "Deposit" : "Withdraw"}</h1>
            {isIra && isDeposit && ira && year && (
                <section className="transfer-fields ira-contribution">
                    {ira.years.length > 1 && (
                        <label className="transfer-field">
                            <span className="transfer-field-label">Tax year</span>
                            <select className="form-control" value={year.taxYear} onChange={event => setTaxYear(Number(event.target.value))}>
                                {ira.years.map(entry => <option key={entry.taxYear} value={entry.taxYear}>{entry.taxYear}{entry.taxYear < new Date().getFullYear() ? ` (until ${entry.deadline})` : ""}</option>)}
                            </select>
                        </label>
                    )}
                    <div className="ira-progress" role="progressbar" aria-valuemin={0} aria-valuemax={year.limit} aria-valuenow={year.contributed} aria-label={`${year.taxYear} contributions`}>
                        <div className="ira-progress-bar" style={{ width: `${Math.min(100, year.contributed / year.limit * 100)}%` }} />
                    </div>
                    <small className="text-muted">
                        {formatCurrency(year.contributed)} of your {formatCurrency(year.limit)} {year.taxYear} limit contributed across your IRAs; {formatCurrency(year.remaining)} left.
                        {" "}The limit counts IRAs here only: contributions elsewhere, and income limits for a Roth, are yours to keep track of.
                    </small>
                </section>
            )}
            {isIra && !isDeposit && ira?.account && (
                <section className="transfer-fields">
                    <label className="transfer-field">
                        <span className="transfer-field-label">Reason (the IRS needs one; it sets the 1099-R&apos;s code)</span>
                        <select className="form-control" value={chosenReason} onChange={event => setReason(event.target.value)}>
                            {reasons.map(entry => <option key={entry.reason} value={entry.reason}>{entry.label} (code {entry.code})</option>)}
                        </select>
                    </label>
                    <div className="transfer-row">
                        <label className="transfer-field">
                            <span className="transfer-field-label">Federal withholding</span>
                            <QuantityStepper value={fedPct} setValue={pct => setFedPct(Math.min(100, Math.max(0, pct)))} max={100} decimals={2} />
                        </label>
                        <label className="transfer-field">
                            <span className="transfer-field-label">State withholding</span>
                            <QuantityStepper value={statePct} setValue={pct => setStatePct(Math.min(100, Math.max(0, pct)))} max={100} decimals={2} />
                        </label>
                    </div>
                    <small className="text-muted">
                        {withholding
                            ? `You receive ${formatCurrency(withholding.net)}; ${formatCurrency(withholding.fedAmount)} federal and ${formatCurrency(withholding.stateAmount)} state tax is withheld and sent to the tax authorities.`
                            : "Federal and state withholding can't add up to more than 100%."}
                        {" "}Federal withholding is 10% unless you set it to 0%.{ira.account.subType === "traditional" ? " Distributions before 59½ usually owe a 10% penalty too." : ""}
                    </small>
                </section>
            )}
            {!isDeposit && account && (
                <p className="transfer-available">
                    Withdrawable: <strong>{formatCurrency(withdrawable)}</strong>
                    {account.pendingTransferOut > 0 && <span className="transfer-restricted"><br />{formatCurrency(account.pendingTransferOut)} already requested</span>}
                    {(account.initialMargin > 0 || account.debitBalance > 0) && <span className="transfer-restricted"><br />Margin positions hold back {formatCurrency(account.initialMargin)} (Reg T initial margin){account.debitBalance > 0 ? `, and ${formatCurrency(account.debitBalance)} is borrowed` : ""}</span>}
                </p>
            )}
            {loadError && <p className="text-danger">Couldn&apos;t load your bank details: {loadError}</p>}

            {!isDeposit && (
                <div className="method-tiles" role="radiogroup" aria-label="Withdrawal method">
                    <button type="button" role="radio" aria-checked={method === "ach"} className={`method-tile${method === "ach" ? " active" : ""}`} onClick={() => setMethod("ach")}>ACH (free, next banking day)</button>
                    <button type="button" role="radio" aria-checked={method === "wire"} className={`method-tile${method === "wire" ? " active" : ""}`} onClick={() => setMethod("wire")}>Wire ({formatCurrency(wireFee)}, same day)</button>
                </div>
            )}

            {(isDeposit || method === "ach") && relationships !== null && accountId && (
                <section className="transfer-fields">
                    <span className="transfer-field-label">{isDeposit ? "From" : "To"} your linked bank</span>
                    <BankLink accountId={accountId} holderName={holderName} relationships={relationships} onChanged={reload} plaid={terms?.plaid} simulated={terms?.simulated ?? true} />
                </section>
            )}

            {method === "wire" && !isDeposit && (
                <section className="transfer-fields">
                    <span className="transfer-field-label">To</span>
                    {banks.length > 0 && (
                        <select className="form-control" value={chosenBank} onChange={event => setBankId(event.target.value)} aria-label="Recipient bank">
                            {banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name} {bank.account_number}</option>)}
                            <option value="">Another bank…</option>
                        </select>
                    )}
                    {addingBank && (
                        <div className="transfer-fields">
                            <input className="form-control" placeholder="Bank name" value={newBank.name} onChange={event => setNewBank({ ...newBank, name: event.target.value })} />
                            <div className="transfer-row">
                                <input className="form-control" placeholder="Routing number" inputMode="numeric" maxLength={9} value={newBank.routing} onChange={event => setNewBank({ ...newBank, routing: digitsOnly(event.target.value) })} />
                                <input className="form-control" placeholder="Account number" inputMode="numeric" maxLength={17} value={newBank.account} onChange={event => setNewBank({ ...newBank, account: digitsOnly(event.target.value) })} />
                            </div>
                            <small className="text-muted">The account must be in your name. Domestic wires only.</small>
                        </div>
                    )}
                </section>
            )}

            <form onSubmit={submit}>
                <div className="transfer-amount">
                    <span className="transfer-field-label">Amount</span>
                    <QuantityStepper value={value} setValue={setValue} max={maxAmount} decimals={2} prefix="$" />
                    <div className="amount-chips">
                        {QUICK_AMOUNTS.map(quick => (
                            <button type="button" key={quick} className="amount-chip" disabled={quick > maxAmount} onClick={() => setValue(quick)}>{formatCurrency(quick)}</button>
                        ))}
                        {!isDeposit && <button type="button" className="amount-chip" disabled={maxAmount <= 0} onClick={() => setValue(maxAmount)}>Max</button>}
                    </div>
                    {!isDeposit && account && maxAmount <= 0 && (
                        <small className="text-danger">{marginCall ? "Withdrawals wait until the margin call is met." : "Nothing available to withdraw."}</small>
                    )}
                    {isDeposit && marginCall && account && (
                        <small className="text-danger">Depositing {formatCurrency(account.marginCalls.reduce((sum, call) => sum + call.amount, 0))} or more meets your margin call.</small>
                    )}
                    {isDeposit && terms && terms.instant > 0 && (
                        <small className="text-muted">Up to {formatCurrency(terms.instant)} is available to trade at once; the rest when the deposit settles, usually the next banking day.</small>
                    )}
                </div>
                <button type="submit" disabled={!canSubmit} className={`transfer-submit ${isDeposit ? "buy-btn" : "sell-btn"}`}>
                    {submitting ? "Processing…" : `${isDeposit ? "Deposit" : "Withdraw"} ${formatCurrency(value)}`}
                </button>
            </form>
            {status && <p className={`mt-3 ${status.ok ? "text-success" : "text-danger"}`}>{status.message}</p>}
            <p className="mock-note">
                Simulated transfers: no real money moves. Deposits with .01, .02 or .10 cents come back as returns (R01, R02, R10). <Link href="/transfers">Transfer history</Link>
            </p>
        </div>
    );
};

export default TransferForm;
