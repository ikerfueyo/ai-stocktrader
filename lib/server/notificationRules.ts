// Which broker events become notifications, and what they say: the trade, account, transfer and non-trade activity streams in
// Alpaca's shapes (the simulator's sim_events, Alpaca's SSE later). Pure, so it can be unit tested; lib/server/notifications.ts stores
// them. Events the user caused and sees at once (an order placed or cancelled, a deposit requested) and routine ones (regulatory
// fees, each step of a transfer) don't notify.
import { contractName, parseOptionSymbol } from "../options";

export const NOTIFICATION_KINDS = ["orders", "transfers", "account", "margin", "dividends", "corporate_actions", "documents", "alerts", "recurring"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const KIND_LABELS: Record<NotificationKind, string> = {
    orders: "Orders: fills, expiries, cancellations and rejections", transfers: "Transfers and their fees", account: "Account status", margin: "Margin calls and liquidations",
    dividends: "Dividends, interest and withholding", corporate_actions: "Corporate actions", documents: "New documents", alerts: "Price alerts",
    recurring: "Recurring buys and dividend reinvestment"
};

export interface NotificationDraft {
    kind: NotificationKind;
    title: string;
    body: string;
    link: string | null;
    // Makes a notification at most once (the event's ID, or what it's about)
    dedupeKey: string;
}

export interface BrokerEventLike {
    id: string;
    stream: "trades" | "accounts" | "transfers" | "nta";
    payload: Record<string, unknown>;
}

const money = (value: unknown) => `$${Math.abs(Number(value)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shares = (value: unknown) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });

type OrderLike = { id?: string; client_order_id?: string; order_class?: string; legs?: OrderLike[] | null; ratio_qty?: string; side?: string; symbol?: string; qty?: string | null; notional?: string | null; filled_qty?: string; filled_avg_price?: string | null; type?: string; limit_price?: string | null; stop_price?: string | null };

// Which kind an order's events are: the simulator's own liquidations, recurring buys and reinvested dividends by their client order ID
const orderKind = (order: OrderLike): NotificationKind => {
    const id = order.client_order_id ?? "";
    if (id.startsWith("liquidation-")) return "margin";
    if (id.startsWith("recurring-") || id.startsWith("drip-")) return "recurring";
    return "orders";
};

// A stock's symbol, or an option contract's name
const nameOf = (symbol: string | undefined) => symbol ? contractName(symbol) : "";

// An mleg order: its underlying and legs ("F spread: buy 1 F Nov 20 2026 12 Call, sell 1 F Nov 20 2026 13 Call")
const spreadLabel = (order: OrderLike) => {
    const legs = order.legs ?? [];
    const underlying = parseOptionSymbol(legs[0]?.symbol ?? "")?.underlying ?? "Option";
    return `${underlying} spread: ${legs.map(leg => `${leg.side} ${leg.ratio_qty ?? 1} ${nameOf(leg.symbol)}`).join(", ")}`;
};

const orderLabel = (order: OrderLike) => {
    if (order.order_class === "mleg") return `${spreadLabel(order)} × ${shares(order.qty)}`;
    const size = order.qty ? `${shares(order.qty)} ${nameOf(order.symbol)}` : order.notional ? `${money(order.notional)} of ${order.symbol}` : order.symbol ?? "";
    const price = order.type === "limit" ? ` limit ${money(order.limit_price)}` : order.type === "stop" ? ` stop ${money(order.stop_price)}` : order.type === "stop_limit" ? ` stop ${money(order.stop_price)} limit ${money(order.limit_price)}` : "";
    return `${order.side === "sell" ? "Sell" : "Buy"} ${size}${price}`;
};

const ACCOUNT_STATUS: Record<string, { title: string; body: string } | undefined> = {
    ACTIVE: { title: "Your account is open", body: "Fund it and start trading." },
    ACTION_REQUIRED: { title: "Your application needs a document", body: "Upload a photo ID to continue the review." },
    APPROVAL_PENDING: { title: "Your application is under review", body: "It's being reviewed by hand; this can take a little longer." },
    REJECTED: { title: "Your application wasn't approved", body: "You can apply again." },
    ACCOUNT_UPDATED: { title: "Your updated details are being reviewed", body: "Withdrawals wait until the review finishes." },
    ACCOUNT_CLOSED: { title: "Your account is closed", body: "Its records are kept." }
};

export const notificationFor = (event: BrokerEventLike): NotificationDraft | null => {
    const payload = event.payload;
    const dedupeKey = `event:${event.id}`;
    if (event.stream === "trades") {
        const order = (payload.order ?? {}) as OrderLike;
        const kind = orderKind(order);
        const link = kind === "recurring" ? "/notifications?tab=recurring" : "/transactions?tab=orders";
        const reason = typeof payload.reason === "string" ? payload.reason : null;
        switch (payload.event) {
            case "fill":
            case "partial_fill": {
                if (order.order_class === "mleg") {
                    const net = Number(payload.price);
                    return { kind, title: `Spread filled at ${money(net)} ${net >= 0 ? "debit" : "credit"}`, body: `${spreadLabel(order)}, × ${shares(payload.qty)}`, link: "/transactions?tab=trades", dedupeKey };
                }
                const partial = payload.event === "partial_fill";
                const verb = order.side === "sell" ? "Sold" : "Bought";
                const title = kind === "margin" ? `Liquidated to meet a margin call: ${verb.toLowerCase()} ${shares(payload.qty)} ${nameOf(order.symbol)}`
                    : `${partial ? "Partly filled: " : ""}${verb} ${shares(payload.qty)} ${nameOf(order.symbol)} at ${money(payload.price)}`;
                const body = kind === "recurring" ? (order.client_order_id?.startsWith("drip-") ? "Dividend reinvested." : "Your recurring buy filled.")
                    : partial ? `${shares(order.filled_qty)} of ${shares(order.qty)} filled so far.` : "";
                return { kind, title, body, link: "/transactions?tab=trades", dedupeKey };
            }
            case "canceled":
                // A cancel the user asked for has no reason
                return reason ? { kind, title: `Order cancelled: ${orderLabel(order)}`, body: reason === "CORPORATE_ACTION" ? "Cancelled for a corporate action." : reason, link, dedupeKey } : null;
            case "expired":
                return { kind, title: `Order expired: ${orderLabel(order)}`, body: reason ?? "", link, dedupeKey };
            case "rejected":
                return { kind, title: `Order rejected: ${orderLabel(order)}`, body: reason ?? "", link, dedupeKey };
            case "replaced":
                return reason === "CORPORATE_ACTION" ? { kind, title: `Order adjusted for a corporate action: ${orderLabel(order)}`, body: "A new order with the adjusted terms replaced it.", link, dedupeKey } : null;
            default:
                return null;
        }
    }
    if (event.stream === "accounts") {
        if (payload.event === "margin_call" || payload.event === "margin_call_met" || payload.event === "margin_call_liquidated") {
            const call = (payload.margin_call ?? {}) as { type?: string; amount?: string; due_at?: string };
            const what = `${call.type === "regt" ? "Reg T" : "maintenance"} margin call of ${money(call.amount)}`;
            const title = payload.event === "margin_call" ? `A ${what}` : payload.event === "margin_call_met" ? `Your ${what} is met` : `Positions were liquidated for your ${what}`;
            const body = payload.event === "margin_call" && call.due_at ? `Due ${new Date(call.due_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET: deposit or close positions.` : "";
            return { kind: "margin", title, body, link: "/portfolio", dedupeKey };
        }
        const status = payload.status_to as string | undefined;
        if (!status || status === payload.status_from) return null;
        const message = ACCOUNT_STATUS[status];
        return message ? { kind: "account", ...message, link: status === "ACTION_REQUIRED" || status === "REJECTED" ? "/" : "/settings", dedupeKey } : null;
    }
    if (event.stream === "transfers") {
        const status = payload.status_to;
        if (status === "COMPLETE") return { kind: "transfers", title: "A transfer completed", body: "The money has arrived.", link: "/transfers", dedupeKey };
        if (status === "RETURNED") return { kind: "transfers", title: "A deposit was returned by the bank", body: "Its credit and a return fee were taken back.", link: "/transfers", dedupeKey };
        if (status === "REJECTED") return { kind: "transfers", title: "A transfer was rejected", body: "", link: "/transfers", dedupeKey };
        return null;
    }
    // Non-trade activities
    const type = payload.activity_type;
    const subType = payload.activity_sub_type;
    const amount = Number(payload.net_amount ?? 0);
    const symbol = typeof payload.symbol === "string" ? payload.symbol : "";
    const description = typeof payload.description === "string" ? payload.description : "";
    if (type === "DIV" && subType !== "SDIV") {
        return amount >= 0
            ? { kind: "dividends", title: `Dividend received: ${money(amount)} from ${symbol}`, body: description, link: "/transactions?tab=cash", dedupeKey }
            : { kind: "dividends", title: `Dividend charged on your ${symbol} short: ${money(amount)}`, body: description, link: "/transactions?tab=cash", dedupeKey };
    }
    // Options leaving the account: exercised, assigned or expired
    if (type === "OPEXC" || type === "OPASN" || type === "OPEXP") {
        const name = nameOf(symbol);
        return type === "OPEXC" ? { kind: "orders", title: `Option exercised: ${name}`, body: "The shares were traded at the strike.", link: "/portfolio", dedupeKey }
            : type === "OPASN" ? { kind: "orders", title: `Option assigned: ${name}`, body: "Your short contracts were assigned: the shares were delivered at the strike.", link: "/portfolio", dedupeKey }
                : { kind: "orders", title: `Option expired: ${name}`, body: "It expired out of the money, worthless.", link: "/transactions?tab=activity", dedupeKey };
    }
    if (type === "INT") return { kind: "dividends", title: `Margin interest charged: ${money(amount)}`, body: description, link: "/transactions?tab=cash", dedupeKey };
    if (type === "WH") return { kind: "dividends", title: `Backup withholding: ${money(amount)}`, body: description, link: "/settings", dedupeKey };
    if (type === "SPLIT" || type === "MA" || type === "SPIN" || type === "REORG" || type === "CIL" || (type === "DIV" && subType === "SDIV")) {
        return { kind: "corporate_actions", title: `Corporate action: ${description}`, body: "", link: "/transactions?tab=activity", dedupeKey };
    }
    // Fees other than the regulatory pass-throughs (wire, ACH return, locate and borrow fees)
    if (type === "FEE" && !["REG", "TAF", "CAT", "ORF", "OCC"].includes(String(subType))) {
        return { kind: "transfers", title: `Fee charged: ${money(amount)}`, body: description, link: "/transactions?tab=cash", dedupeKey };
    }
    return null;
};
