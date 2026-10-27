"use client";

import { useState, type FormEvent } from "react";
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
import type { BrokerTransfer, TransferRequest } from "@/lib/types";

type Direction = "deposit" | "withdraw";

const QUICK_AMOUNTS = [100, 500, 1000];
const DEFAULT_AMOUNT = 100;

const expected = (iso: string) => formatEastern(iso, { withDay: true });

// Deposit or withdraw money. Deposits come by ACH from the linked bank account (linked here first if there's none), with up to the
// instant limit credited at once. Withdrawals go by ACH to it (free, next banking day) or by wire to a recipient bank (with its fee,
// the same day), and only from withdrawable cash.
const TransferForm = ({ direction }: { direction: Direction }) => {
    const { account, refreshAccount } = useAccount();
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
    const maxAmount = isDeposit ? terms?.dailyAch ?? 0 : Math.max(0, roundCents(withdrawable - fee));
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
                ...(isDeposit || method === "ach" ? { relationshipId: approved?.id } : { bankId: recipient })
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
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: apiErrorMessage(error) });
        } finally {
            setSubmitting(false);
        }
    };

    const needsBank = (isDeposit || method === "ach") && !approved;
    const canSubmit = !submitting && value > 0 && value <= maxAmount && !needsBank && (!addingBank || newBankValid) && !(isDeposit ? false : marginCall);

    return (
        <div className="transfer-container mt-5">
            <h1 className="transfer-title">{isDeposit ? "Deposit" : "Withdraw"}</h1>
            {!isDeposit && account && (
                <p className="transfer-available">
                    Withdrawable: <strong>{formatCurrency(withdrawable)}</strong>
                    {account.pendingTransferOut > 0 && <span className="transfer-restricted"><br />{formatCurrency(account.pendingTransferOut)} already requested</span>}
                    {account.restrictedCash > 0 && <span className="transfer-restricted"><br />{formatCurrency(account.restrictedCash)} is held as short collateral</span>}
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
                    <BankLink accountId={accountId} holderName={holderName} relationships={relationships} onChanged={reload} />
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
                        <small className="text-danger">{marginCall ? "Withdrawals are blocked during a margin call (collateral shortfall)." : "Nothing available to withdraw."}</small>
                    )}
                    {isDeposit && marginCall && account && (
                        <small className="text-danger">Depositing {formatCurrency(account.collateralShortfall)} or more fixes your collateral shortfall.</small>
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
