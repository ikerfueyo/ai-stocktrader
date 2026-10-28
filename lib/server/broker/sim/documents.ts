import "server-only";
import { randomUUID } from "node:crypto";
import pool from "../../db";
import { BrokerError } from "../errors";
import { fetchQuotes } from "../../marketData";
import { positionsAt, roundCents, type Split } from "../../account";
import { addDays, easternParts } from "../../../marketHours";
import { getAccount } from "./accounts";
import { fillsAsTrades } from "./positions";
import { subjectToBackupWithholding } from "./withholding";
import { renderDocument, type ApplicationPayload, type DocumentPayload, type Holder, type RenderableDocument, type StatementPayload, type TaxStatementPayload, type TradeConfirmationPayload } from "./documentRender";
import { reportSales, taxYear, termOf, type Acquisition, type Disposal, type ReportedSale, type TaxYear } from "./tax";
import type { SimAccountRow } from "./shapes";
import type { AccountDocument, ListDocumentsQuery } from "../types";

// The simulator's account documents (Alpaca's GET /v1/accounts/{id}/documents and their download), kept in sim_documents with the
// data each shows and rendered on download (./documentRender.ts): a trade confirmation for each trading day with fills, from the
// next day (with its JSON version, trade_confirmation_json); a monthly account statement, from the first Monday after the month
// ends ("after the first weekend"); a copy of the account application; and the consolidated 1099 for each year with activity, from
// February 15 of the next year. Each is made once, when the job or a listing finds it due; development can make preliminary ones.

type DocumentType = RenderableDocument["type"];

interface DocumentRow {
    id: string; account_id: string; type: DocumentType; sub_type: string | null; name: string; date: string; period_start: string; period_end: string;
    preliminary: boolean; payload: DocumentPayload; created_at: Date;
}

const today = (now: Date) => easternParts(now).dateKey;
// The first day of the month after the one starting at month, and the last day of month's
const nextMonth = (month: string) => `${addDays(month, 31).slice(0, 8)}01`;
const monthEnd = (month: string) => addDays(nextMonth(month), -1);
const figuresOnly = ({ allSales, ...figures }: TaxYear & { allSales: ReportedSale[] }): TaxYear => (void allSales, figures);
const monthName = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const accountRow = async (accountId: string): Promise<SimAccountRow> => {
    const { rows: [row] } = await pool.query<SimAccountRow>("SELECT * FROM sim_accounts WHERE id = $1", [accountId]);
    if (!row) throw new BrokerError(404, 40410000, "account not found");
    return row;
};

const holderOf = (row: SimAccountRow): Holder => {
    const contact = (row.contact ?? {}) as { street_address?: string[]; unit?: string; city?: string; state?: string; postal_code?: string };
    const identity = (row.identity ?? {}) as { given_name?: string; middle_name?: string; family_name?: string };
    return {
        name: [identity.given_name, identity.middle_name, identity.family_name].filter(Boolean).join(" ") || "Account holder",
        accountNumber: row.account_number,
        address: [...(contact.street_address ?? []), contact.unit ?? "", [contact.city, [contact.state, contact.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean)
    };
};

const store = async (accountId: string, doc: { type: DocumentType; subType?: string | null; name: string; date: string; periodStart: string; periodEnd: string; preliminary?: boolean; payload: DocumentPayload }) => {
    await pool.query(
        `INSERT INTO sim_documents (id, account_id, "type", sub_type, name, "date", period_start, period_end, preliminary, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (account_id, "type", period_start, period_end, preliminary) DO UPDATE SET name = EXCLUDED.name, "date" = EXCLUDED."date", payload = EXCLUDED.payload, created_at = now()
         WHERE sim_documents.preliminary`,
        [randomUUID(), accountId, doc.type, doc.subType ?? null, doc.name, doc.date, doc.periodStart, doc.periodEnd, doc.preliminary ?? false, JSON.stringify(doc.payload)]
    );
};

// A day's trade confirmation: every fill with its price, principal, the regulatory fees it accrued and its settlement date
const confirmationPayload = async (accountId: string, holder: Holder, day: string): Promise<TradeConfirmationPayload> => {
    const { rows } = await pool.query<{ id: string; created_at: Date; side: "buy" | "sell"; symbol: string; qty: string; price: string; net_amount: string; settle_date: string | null; order_id: string | null; reason: string | null }>(
        `SELECT id, created_at, side, symbol, qty, price, net_amount, settle_date::text, order_id, reason FROM sim_activities WHERE account_id = $1 AND activity_type = 'FILL' AND "date" = $2 ORDER BY created_at, id`,
        [accountId, day]
    );
    const { rows: fees } = await pool.query<{ fill_id: string; fee_type: "REG" | "TAF" | "CAT"; amount: string }>(
        "SELECT fill_id, fee_type, amount FROM sim_fee_accruals WHERE fill_id = ANY($1)", [rows.map(({ id }) => id)]
    );
    return {
        holder, tradeDate: day,
        fills: rows.map(row => {
            const accrued = { REG: 0, TAF: 0, CAT: 0 };
            for (const fee of fees.filter(({ fill_id }) => fill_id === row.id)) accrued[fee.fee_type] += Number(fee.amount);
            return {
                time: row.created_at.toISOString(), side: row.side, symbol: row.symbol, qty: Number(row.qty), price: Number(row.price), principal: Math.abs(Number(row.net_amount)),
                fees: accrued, settleDate: row.settle_date, orderId: row.order_id, liquidation: row.reason === "LIQUIDATION"
            };
        })
    };
};

// A month's statement: the opening and closing balances (the last closes before and in it), what moved in it by kind, every activity,
// and the positions held at its end (from the replayed fills and splits)
const statementPayload = async (accountId: string, holder: Holder, start: string, end: string): Promise<StatementPayload> => {
    const [{ rows: [opening] }, { rows: [closing] }, { rows: activities }, trades] = await Promise.all([
        pool.query<{ date: string; equity: string; cash: string }>(`SELECT "date"::text, equity, cash FROM sim_daily_balances WHERE account_id = $1 AND "date" < $2 ORDER BY "date" DESC LIMIT 1`, [accountId, start]),
        pool.query<{ date: string; equity: string; cash: string; long_market_value: string; short_market_value: string }>(
            `SELECT "date"::text, equity, cash, long_market_value, short_market_value FROM sim_daily_balances WHERE account_id = $1 AND "date" <= $2 AND "date" >= $3 ORDER BY "date" DESC LIMIT 1`, [accountId, end, start]
        ),
        pool.query<{ date: string; activity_type: string; activity_sub_type: string | null; side: string | null; description: string; net_amount: string; realized_pl: string | null }>(
            `SELECT "date"::text, activity_type, activity_sub_type, side, description, net_amount, realized_pl FROM sim_activities WHERE account_id = $1 AND "date" BETWEEN $2 AND $3 ORDER BY created_at, id`,
            [accountId, start, end]
        ),
        fillsAsTrades(pool, accountId)
    ]);
    const sum = (filter: (row: (typeof activities)[number]) => boolean, sign = 1) => roundCents(activities.filter(filter).reduce((total, row) => total + sign * Number(row.net_amount), 0));
    const { rows: splitRows } = await pool.query<{ ticker: string; ex_date: string; factor: string }>(
        `SELECT ticker, ex_date::text, factor FROM corporate_actions WHERE "type" = 'SPLIT' AND ticker = ANY($1)`, [[...new Set(trades.map(({ ticker }) => ticker))]]
    );
    const splits: Split[] = splitRows.map(row => ({ ticker: row.ticker, exDate: row.ex_date, factor: Number(row.factor) }));
    const held = positionsAt(trades, splits, addDays(end, 1));
    return {
        holder, periodStart: start, periodEnd: end,
        opening: opening ? { date: opening.date, equity: Number(opening.equity), cash: Number(opening.cash) } : null,
        closing: closing ? { date: closing.date, equity: Number(closing.equity), cash: Number(closing.cash), longMarketValue: Number(closing.long_market_value), shortMarketValue: Number(closing.short_market_value) } : null,
        summary: {
            deposits: sum(row => row.activity_type === "CSD"), withdrawals: sum(row => row.activity_type === "CSW", -1),
            bought: sum(row => row.activity_type === "FILL" && row.side === "buy", -1), sold: sum(row => row.activity_type === "FILL" && row.side === "sell"),
            dividends: sum(row => row.activity_type === "DIV"), fees: sum(row => row.activity_type === "FEE", -1), interest: sum(row => row.activity_type === "INT", -1),
            withholding: sum(row => row.activity_type === "WH", -1), corporateActions: sum(row => row.activity_type === "MA" || row.activity_type === "CIL"),
            realized: roundCents(activities.reduce((total, row) => total + Number(row.realized_pl ?? 0), 0))
        },
        activities: activities.map(row => ({ date: row.date, type: row.activity_type, description: row.description, amount: Number(row.net_amount) })),
        positions: held.map(({ ticker, quantity, avgCost }) => ({ symbol: ticker, qty: quantity, avgCost, costBasis: roundCents(Math.abs(quantity) * avgCost) }))
    };
};

// The account's disposals and purchases as the tax rules take them, and its dividends, interest and withholding
const taxInputs = async (accountId: string) => {
    const [{ rows: closings }, { rows: lots }, { rows: cash }] = await Promise.all([
        pool.query<{ id: number; lot_id: string; qty: string; lot_price: string; close_price: string; closed_at: Date; side: "long" | "short"; acquired_at: Date; activity_type: string; symbol: string }>(
            `SELECT c.id, c.lot_id, c.qty, c.lot_price, c.close_price, c.closed_at, l.side, l.acquired_at, a.activity_type, COALESCE(a.symbol, l.symbol) AS symbol
             FROM sim_lot_closings c JOIN sim_lots l ON l.id = c.lot_id JOIN sim_activities a ON a.id = c.fill_id WHERE c.account_id = $1 AND c.qty > 0`, [accountId]
        ),
        // Purchases (lots a fill opened) can replace shares sold at a loss; lots a corporate action opened can't
        pool.query<{ id: string; symbol: string; side: "long" | "short"; qty: string; price: string; acquired_at: Date }>(
            `SELECT l.id, l.symbol, l.side, l.original_qty AS qty, l.price, l.acquired_at FROM sim_lots l JOIN sim_activities a ON a.id = l.fill_id WHERE l.account_id = $1 AND a.activity_type = 'FILL'`, [accountId]
        ),
        pool.query<{ date: string; activity_type: string; activity_sub_type: string | null; net_amount: string; reason: string | null }>(
            `SELECT "date"::text, activity_type, activity_sub_type, net_amount, reason FROM sim_activities WHERE account_id = $1 AND activity_type IN ('DIV', 'INT', 'WH')`, [accountId]
        )
    ]);
    const kinds: Record<string, Disposal["kind"]> = { FILL: "sale", MA: "merger", CIL: "cash_in_lieu", REORG: "worthless" };
    const disposals: Disposal[] = closings.map(row => ({
        id: String(row.id), lotId: row.lot_id, symbol: row.symbol, side: row.side, qty: Number(row.qty), lotPrice: Number(row.lot_price), price: Number(row.close_price),
        acquiredAt: row.acquired_at.toISOString(), closedAt: row.closed_at.toISOString(), kind: kinds[row.activity_type] ?? "sale"
    }));
    const acquisitions: Acquisition[] = lots.map(row => ({ lotId: row.id, symbol: row.symbol, side: row.side, qty: Number(row.qty), acquiredAt: row.acquired_at.toISOString() }));
    return {
        disposals, acquisitions,
        dividends: cash.filter(row => row.activity_type === "DIV" && row.activity_sub_type !== "SDIV").map(row => ({ date: row.date, amount: Number(row.net_amount) })),
        interest: cash.filter(row => row.activity_type === "INT" && Number(row.net_amount) > 0).map(row => ({ date: row.date, amount: Number(row.net_amount) })),
        withholding: cash.filter(row => row.activity_type === "WH").map(row => ({ date: row.date, amount: -Number(row.net_amount), on: (row.reason === "dividends" ? "dividends" : row.reason === "interest" ? "interest" : "proceeds") as "dividends" | "proceeds" | "interest" }))
    };
};

// The year's 1099 figures, with every reported sale of the account's history (wash sales cross years)
export const accountTaxYear = async (accountId: string, year: number): Promise<TaxYear & { allSales: ReportedSale[] }> => {
    const inputs = await taxInputs(accountId);
    const { sales } = reportSales(inputs.acquisitions, inputs.disposals);
    return { ...taxYear({ year, sales, dividends: inputs.dividends, interest: inputs.interest, withholding: inputs.withholding }), allSales: sales };
};

// The open lots with their tax basis (wash sale losses added) and holding period (carried over from washed shares), at current prices
export const unrealizedLots = async (accountId: string) => {
    const inputs = await taxInputs(accountId);
    const { adjustments } = reportSales(inputs.acquisitions, inputs.disposals);
    const { rows } = await pool.query<{ id: string; symbol: string; side: "long" | "short"; qty: string; original_qty: string; price: string; acquired_at: Date }>(
        "SELECT id, symbol, side, qty, original_qty, price, acquired_at FROM sim_lots WHERE account_id = $1 AND qty > 0 ORDER BY symbol, acquired_at", [accountId]
    );
    const symbols = [...new Set(rows.map(({ symbol }) => symbol))];
    const quotes = await Promise.allSettled(fetchQuotes(symbols));
    const prices = new Map(symbols.flatMap((symbol, i) => quotes[i].status === "fulfilled" ? [[symbol, (quotes[i] as PromiseFulfilledResult<{ price: number }>).value.price] as const] : []));
    const now = new Date().toISOString();
    return rows.map(row => {
        const qty = Number(row.qty);
        const adjustment = adjustments.get(row.id);
        const wash = adjustment ? adjustment.basis * qty / Number(row.original_qty) : 0;
        const basis = roundCents(qty * Number(row.price) + wash);
        const price = prices.get(row.symbol) ?? null;
        const value = price === null ? null : roundCents(qty * price);
        const dateAcquired = adjustment ? new Date(row.acquired_at.getTime() - adjustment.carriedDays * 86400000).toISOString() : row.acquired_at.toISOString();
        return {
            id: row.id, symbol: row.symbol, side: row.side, qty, acquiredAt: row.acquired_at.toISOString(), dateAcquired, price: Number(row.price), costBasis: basis,
            washAdjustment: roundCents(wash), marketValue: value, unrealized: value === null ? null : roundCents(row.side === "long" ? value - basis : basis - value),
            term: row.side === "long" ? termOf(dateAcquired, now) : "short" as const
        };
    });
};

// The first Monday after a month ends (its statement is out "after the first weekend")
const statementDue = (monthEnd: string) => {
    let day = addDays(monthEnd, 1);
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) day = addDays(day, 1);
    return day;
};

// Makes the account's documents that are due and missing: the application, each past trading day's confirmations, each finished
// month's statement once out, and each past year's 1099 from February 15
export const generateDocuments = async (accountId: string, now = new Date()) => {
    const row = await accountRow(accountId);
    const holder = holderOf(row);
    const day = today(now);
    const { rows: existing } = await pool.query<{ type: DocumentType; period_start: string }>(
        `SELECT "type", period_start::text FROM sim_documents WHERE account_id = $1 AND NOT preliminary`, [accountId]
    );
    const has = (type: DocumentType, start: string) => existing.some(doc => doc.type === type && doc.period_start === start);
    const created = row.created_at.toISOString();
    const createdDay = today(row.created_at);
    let made = 0;
    if (!existing.some(doc => doc.type === "account_application")) {
        const { rows: attestations } = await pool.query<{ kind: string; signed_at: Date; ip_address: string | null; details: Record<string, unknown> }>(
            "SELECT kind, signed_at, ip_address, details FROM account_attestations WHERE account_id = $1 ORDER BY signed_at, id", [accountId]
        ).catch(() => ({ rows: [] }));
        const payload: ApplicationPayload = {
            holder, submittedAt: created, account: await getAccount(accountId) as unknown as Record<string, unknown>,
            attestations: attestations.map(entry => ({ kind: entry.kind, at: entry.signed_at.toISOString(), ipAddress: entry.ip_address, details: entry.details ?? {} }))
        };
        await store(accountId, { type: "account_application", name: "Account application", date: createdDay, periodStart: createdDay, periodEnd: createdDay, payload });
        made++;
    }
    const { rows: fillDays } = await pool.query<{ day: string }>(
        `SELECT DISTINCT "date"::text AS day FROM sim_activities WHERE account_id = $1 AND activity_type = 'FILL' AND "date" < $2 ORDER BY day`, [accountId, day]
    );
    for (const { day: tradeDay } of fillDays.filter(({ day: tradeDay }) => !has("trade_confirmation", tradeDay))) {
        const payload = await confirmationPayload(accountId, holder, tradeDay);
        await store(accountId, { type: "trade_confirmation", name: `Trade confirmation ${tradeDay}`, date: tradeDay, periodStart: tradeDay, periodEnd: tradeDay, payload });
        await store(accountId, { type: "trade_confirmation_json", name: `Trade confirmation ${tradeDay} (JSON)`, date: tradeDay, periodStart: tradeDay, periodEnd: tradeDay, payload });
        made += 2;
    }
    for (let month = `${createdDay.slice(0, 7)}-01`; month < `${day.slice(0, 7)}-01`; month = nextMonth(month)) {
        const end = monthEnd(month);
        if (has("account_statement", month) || day < statementDue(end)) continue;
        await store(accountId, { type: "account_statement", subType: "monthly", name: `Account statement ${monthName(month)}`, date: end, periodStart: month, periodEnd: end, payload: await statementPayload(accountId, holder, month, end) });
        made++;
    }
    for (let year = Number(createdDay.slice(0, 4)); year < Number(day.slice(0, 4)); year++) {
        const start = `${year}-01-01`;
        if (has("tax_statement", start) || day < `${year + 1}-02-15`) continue;
        const figures = figuresOnly(await accountTaxYear(accountId, year));
        const active = figures.form1099B.sales.length > 0 || figures.form1099DIV.ordinaryDividends > 0 || figures.form1099INT.interestIncome > 0;
        if (!active) continue;
        const payload: TaxStatementPayload = { holder, taxYear: figures, backupWithholding: await subjectToBackupWithholding(accountId) };
        await store(accountId, { type: "tax_statement", subType: "1099-Comp", name: `Consolidated 1099 for ${year}`, date: `${year + 1}-02-15`, periodStart: start, periodEnd: `${year}-12-31`, payload });
        made++;
    }
    return made;
};

// Development only: preliminary versions of this month's statement (to date) and a year's consolidated 1099, made again each time
export const generatePreliminaryDocuments = async (accountId: string, year: number, now = new Date()) => {
    const row = await accountRow(accountId);
    const holder = holderOf(row);
    const day = today(now);
    const month = `${day.slice(0, 7)}-01`;
    await store(accountId, { type: "account_statement", subType: "monthly", name: `Account statement ${monthName(month)} (preliminary)`, date: day, periodStart: month, periodEnd: day, preliminary: true, payload: await statementPayload(accountId, holder, month, day) });
    const figures = figuresOnly(await accountTaxYear(accountId, year));
    await store(accountId, {
        type: "tax_statement", subType: "1099-Comp", name: `Consolidated 1099 for ${year} (preliminary)`, date: day, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, preliminary: true,
        payload: { holder, taxYear: figures, backupWithholding: await subjectToBackupWithholding(accountId) }
    });
    // This trading day's confirmation so far, if it has fills
    const { rowCount } = await pool.query(`SELECT 1 FROM sim_activities WHERE account_id = $1 AND activity_type = 'FILL' AND "date" = $2 LIMIT 1`, [accountId, day]);
    if (rowCount) {
        await store(accountId, { type: "trade_confirmation", name: `Trade confirmation ${day} (preliminary)`, date: day, periodStart: day, periodEnd: day, preliminary: true, payload: await confirmationPayload(accountId, holder, day) });
    }
};

const toDocument = (row: Pick<DocumentRow, "id" | "type" | "date" | "name" | "sub_type">): AccountDocument => ({
    id: row.id, type: row.type, date: row.date, name: row.name, ...(row.sub_type ? { sub_type: row.sub_type } : {})
});

// GET /v1/accounts/{id}/documents: newest first, between start and end (dates), of a type; makes the due ones first
export const listDocuments = async (accountId: string, query: ListDocumentsQuery & { type?: string } = {}): Promise<AccountDocument[]> => {
    await generateDocuments(accountId);
    const { rows } = await pool.query<DocumentRow>(
        `SELECT id, "type", "date"::text, name, sub_type FROM sim_documents WHERE account_id = $1 AND ($2::date IS NULL OR "date" >= $2) AND ($3::date IS NULL OR "date" <= $3)
           AND ($4::text IS NULL OR "type" = $4) ORDER BY "date" DESC, created_at DESC`,
        [accountId, query.start ?? null, query.end ?? null, query.type ?? null]
    );
    return rows.map(toDocument);
};

// GET /v1/accounts/{id}/documents/{document_id}/download: the page (a PDF from Alpaca; HTML to print from the simulator), or the JSON of
// a trade_confirmation_json
export const downloadDocument = async (accountId: string, documentId: string): Promise<{ contentType: string; body: Uint8Array }> => {
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw new BrokerError(404, 40410000, "document not found");
    const { rows: [row] } = await pool.query<DocumentRow>(`SELECT *, "date"::text AS "date" FROM sim_documents WHERE id = $1 AND account_id = $2`, [documentId, accountId]);
    if (!row) throw new BrokerError(404, 40410000, "document not found");
    if (row.type === "trade_confirmation_json") {
        return { contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ ...row.payload, preliminary: row.preliminary }, null, 2)) };
    }
    return { contentType: "text/html; charset=utf-8", body: new TextEncoder().encode(renderDocument({ type: row.type, name: row.name, date: row.date, preliminary: row.preliminary, payload: row.payload })) };
};

// The documents job: every open account's due documents
export const generateAllDocuments = async (now = new Date()) => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM sim_accounts WHERE status NOT IN ('REJECTED')");
    let made = 0;
    for (const { id } of rows) made += await generateDocuments(id, now).catch(error => {
        console.error(`Sim documents for ${id}: ${error.message}`);
        return 0;
    });
    return made;
};

