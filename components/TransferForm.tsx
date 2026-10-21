"use client";

import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import axios from "axios";
import QuantityStepper from "./QuantityStepper";
import { useAccount } from "@/context/AccountContext";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { formatCurrency, roundCents } from "@/lib/orders";
import { describeMethod, detectCardBrand, digitsOnly, expiryValid, formatCardNumber, luhnValid, routingValid, type PaymentDetails, type PaymentMethod } from "@/lib/payments";
import type { TransferRequest } from "@/lib/types";

type Direction = "deposit" | "withdraw";
type FieldErrors = Partial<Record<keyof PaymentDetails, string>>;

const METHODS: Record<Direction, { id: PaymentMethod; label: string }[]> = {
    deposit: [
        { id: "card", label: "Card" },
        { id: "apple", label: "Apple Pay" },
        { id: "google", label: "Google Pay" },
        { id: "paypal", label: "PayPal" },
        { id: "bank", label: "Bank account" }
    ],
    withdraw: [
        { id: "bank", label: "Bank account" },
        { id: "card", label: "Debit card" }
    ]
};

const EMPTY_DETAILS: PaymentDetails = { cardNumber: "", expiry: "", cvc: "", cardName: "", holderName: "", routingNumber: "", accountNumber: "", email: "" };
const QUICK_AMOUNTS = [100, 500, 1000];
const DEFAULT_AMOUNT = 100;
// The most the server's amount column holds
const MAX_AMOUNT = 99999999.99;

// A message per invalid field of the chosen method (Apple Pay and Google Pay have no fields)
const validate = (method: PaymentMethod, details: PaymentDetails): FieldErrors => {
    const errors: FieldErrors = {};
    if (method === "card") {
        if (!luhnValid(details.cardNumber)) errors.cardNumber = "Enter a valid card number";
        if (!expiryValid(details.expiry)) errors.expiry = "Enter a valid date (MM/YY)";
        const cvcLength = detectCardBrand(details.cardNumber) === "American Express" ? 4 : 3;
        if (details.cvc.length !== cvcLength) errors.cvc = `Enter ${cvcLength} digits`;
        if (!details.cardName.trim()) errors.cardName = "Enter the name on the card";
    } else if (method === "bank") {
        if (!details.holderName.trim()) errors.holderName = "Enter the account holder's name";
        if (!routingValid(details.routingNumber)) errors.routingNumber = "Enter a valid 9-digit routing number";
        if (details.accountNumber.length < 4) errors.accountNumber = "Enter a 4 to 17 digit account number";
    } else if (method === "paypal") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())) errors.email = "Enter a valid email address";
    }
    return errors;
};

const Field = ({ label, error, children }: { label: ReactNode; error?: string; children: ReactNode }) => (
    <label className="transfer-field">
        <span className="transfer-field-label">{label}</span>
        {children}
        {error && <small className="text-danger">{error}</small>}
    </label>
);

// Mock deposit (direction="deposit") or withdrawal (direction="withdraw") form. Only the method's label and the amount are sent.
const TransferForm = ({ direction = "deposit" }: { direction?: Direction }) => {
    const isDeposit = direction === "deposit";
    const methods = METHODS[direction];
    const { account, refreshAccount } = useAccount();
    const [method, setMethod] = useState<PaymentMethod>(methods[0].id);
    const [details, setDetails] = useState(EMPTY_DETAILS);
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    // Field errors only show once the user has tried to submit
    const [attempted, setAttempted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

    // Withdrawals are capped at the available cash, which excludes short collateral (the server checks again)
    const maxAmount = isDeposit || !account ? MAX_AMOUNT : account.availableCash;
    const marginCall = (account?.collateralShortfall ?? 0) > 0;
    const value = Math.min(amount, maxAmount);
    const errors = validate(method, details);
    const shownErrors: FieldErrors = attempted ? errors : {};
    const brand = details.cardNumber ? detectCardBrand(details.cardNumber) : null;

    const setDetail = (field: keyof PaymentDetails, text: string) => setDetails(prev => ({ ...prev, [field]: text }));
    const setDigits = (field: keyof PaymentDetails, maxLength: number) => (e: ChangeEvent<HTMLInputElement>) => setDetail(field, digitsOnly(e.target.value).slice(0, maxLength));

    const onMethodChange = (id: PaymentMethod) => {
        setMethod(id);
        setAttempted(false);
    };

    const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setAttempted(true);
        if (Object.keys(errors).length > 0 || !(value > 0)) return;
        const transfer: TransferRequest["transfer"] = { type: isDeposit ? "DEPOSIT" : "WITHDRAW", method: describeMethod(method, details), amount: roundCents(value) };
        setSubmitting(true);
        setStatus(null);
        try {
            await axios.post("/api/transfers", { transfer } satisfies TransferRequest);
            setStatus({ ok: true, message: `${isDeposit ? "Deposited" : "Withdrew"} ${formatCurrency(transfer.amount)} ${isDeposit ? "from" : "to"} ${transfer.method}` });
            setDetails(EMPTY_DETAILS);
            setAmount(DEFAULT_AMOUNT);
            setAttempted(false);
            refreshAccount();
        } catch (error) {
            logError(error);
            setStatus({ ok: false, message: `Couldn't ${isDeposit ? "deposit" : "withdraw"}: ${apiErrorMessage(error)}` });
        } finally {
            setSubmitting(false);
        }
    };

    const expiry = details.expiry.length > 2 ? `${details.expiry.slice(0, 2)}/${details.expiry.slice(2)}` : details.expiry;
    const isWallet = method === "apple" || method === "google";
    const submitLabel = method === "apple" ? `Pay ${formatCurrency(value)} with Apple Pay`
        : method === "google" ? `Pay ${formatCurrency(value)} with Google Pay`
        : `${isDeposit ? "Deposit" : "Withdraw"} ${formatCurrency(value)}`;

    return (
        <div className="transfer-container mt-5">
            <h1 className="transfer-title">{isDeposit ? "Deposit funds" : "Withdraw funds"}</h1>
            <p className="transfer-available">
                Available: <strong>{account ? formatCurrency(account.availableCash) : "…"}</strong>
                {account && account.restrictedCash > 0 && (
                    <span className="transfer-restricted"> ({formatCurrency(account.restrictedCash)} held as short collateral)</span>
                )}
            </p>
            <form onSubmit={onSubmit} noValidate>
                <div className="method-tiles" role="radiogroup" aria-label={isDeposit ? "Pay with" : "Send to"}>
                    {methods.map(({ id, label }) => (
                        <button type="button" key={id} role="radio" aria-checked={method === id}
                            className={`method-tile ${method === id ? "active" : ""}`} onClick={() => onMethodChange(id)}>
                            {label}
                        </button>
                    ))}
                </div>

                {method === "card" && (
                    <div className="transfer-fields">
                        <Field label={<>Card number {brand && <span className="card-brand">{brand}</span>}</>} error={shownErrors.cardNumber}>
                            <input className="form-control" inputMode="numeric" autoComplete="off" placeholder="4242 4242 4242 4242"
                                value={formatCardNumber(details.cardNumber)} onChange={setDigits("cardNumber", 19)} />
                        </Field>
                        <div className="transfer-row">
                            <Field label="Expiry" error={shownErrors.expiry}>
                                <input className="form-control" inputMode="numeric" autoComplete="off" placeholder="MM/YY"
                                    value={expiry} onChange={setDigits("expiry", 4)} />
                            </Field>
                            <Field label="CVC" error={shownErrors.cvc}>
                                <input className="form-control" inputMode="numeric" autoComplete="off" placeholder="123"
                                    value={details.cvc} onChange={setDigits("cvc", 4)} />
                            </Field>
                        </div>
                        <Field label="Name on card" error={shownErrors.cardName}>
                            <input className="form-control" autoComplete="off" value={details.cardName}
                                onChange={e => setDetail("cardName", e.target.value)} />
                        </Field>
                    </div>
                )}

                {method === "bank" && (
                    <div className="transfer-fields">
                        <Field label="Account holder" error={shownErrors.holderName}>
                            <input className="form-control" autoComplete="off" value={details.holderName}
                                onChange={e => setDetail("holderName", e.target.value)} />
                        </Field>
                        <div className="transfer-row">
                            <Field label="Routing number" error={shownErrors.routingNumber}>
                                <input className="form-control" inputMode="numeric" autoComplete="off" placeholder="9 digits"
                                    value={details.routingNumber} onChange={setDigits("routingNumber", 9)} />
                            </Field>
                            <Field label="Account number" error={shownErrors.accountNumber}>
                                <input className="form-control" inputMode="numeric" autoComplete="off" placeholder="4 to 17 digits"
                                    value={details.accountNumber} onChange={setDigits("accountNumber", 17)} />
                            </Field>
                        </div>
                    </div>
                )}

                {method === "paypal" && (
                    <div className="transfer-fields">
                        <Field label="PayPal email" error={shownErrors.email}>
                            <input className="form-control" type="email" autoComplete="off" value={details.email}
                                onChange={e => setDetail("email", e.target.value)} />
                        </Field>
                    </div>
                )}

                {isWallet && (
                    <p className="transfer-wallet-note">No details needed. Confirm with the button below.</p>
                )}

                <div className="transfer-amount">
                    <span className="transfer-field-label">Amount</span>
                    <QuantityStepper value={value} setValue={setAmount} max={maxAmount} decimals={2} prefix="$" />
                    <div className="amount-chips">
                        {QUICK_AMOUNTS.map(quick => (
                            <button type="button" key={quick} className="amount-chip" disabled={quick > maxAmount}
                                onClick={() => setAmount(quick)}>{formatCurrency(quick)}</button>
                        ))}
                        {!isDeposit && (
                            <button type="button" className="amount-chip" disabled={maxAmount <= 0}
                                onClick={() => setAmount(maxAmount)}>Max</button>
                        )}
                    </div>
                    {!isDeposit && account && maxAmount <= 0 && (
                        <small className="text-danger">
                            {marginCall ? "Withdrawals are blocked during a margin call (collateral shortfall)." : "Nothing available to withdraw."}
                        </small>
                    )}
                    {isDeposit && marginCall && account && (
                        <small className="text-danger">
                            Depositing {formatCurrency(account.collateralShortfall)} or more fixes your collateral shortfall.
                        </small>
                    )}
                </div>

                <button type="submit" disabled={submitting || !(value > 0)}
                    className={isWallet ? `wallet-btn ${method}` : `transfer-submit ${isDeposit ? "buy-btn" : "sell-btn"}`}>
                    {submitting ? "Processing…" : submitLabel}
                </button>
            </form>
            {status && <p className={`mt-3 ${status.ok ? "text-success" : "text-danger"}`}>{status.message}</p>}
            <p className="mock-note">Mock payments: no real money moves. Test card: 4242 4242 4242 4242, routing number: 011000015.</p>
        </div>
    );
};

export default TransferForm;
