import "server-only";
import pool from "./db";
import { singleton } from "./cache";
import { HttpError } from "./httpError";
import { fetchAlpacaAssets, fetchListings, isAlpacaConfigured } from "./marketData";
import { buildUniverse, normalizeSymbol, type AssetRow } from "./universe";

// The tradable universe (U.S. common stocks, buildUniverse) in the assets table, synced by the background job 3 times a day and
// kept in memory (reloaded every 10 minutes, so every server process sees a sync). Until the first sync has stored anything,
// nothing is refused (the app keeps working on a fresh database or while Alpha Vantage is down), with a warning.
const state = singleton("assetUniverse", () => ({ assets: null as Map<string, AssetRow> | null, loadedAt: 0, loading: null as Promise<void> | null, warned: false }));
const RELOAD_MS = 10 * 60000;

interface AssetDbRow {
    symbol: string; name: string; exchange: string; alpaca_id: string | null; tradable: boolean | null; marginable: boolean | null;
    shortable: boolean | null; borrow_status: string | null; fractionable: boolean | null; margin_requirement_long: string | null;
    margin_requirement_short: string | null; attributes: string[];
}

const fromDb = (row: AssetDbRow): AssetRow => ({
    symbol: row.symbol, name: row.name, exchange: row.exchange, alpacaId: row.alpaca_id, tradable: row.tradable, marginable: row.marginable,
    shortable: row.shortable, borrowStatus: row.borrow_status, fractionable: row.fractionable,
    marginRequirementLong: row.margin_requirement_long === null ? null : parseFloat(row.margin_requirement_long),
    marginRequirementShort: row.margin_requirement_short === null ? null : parseFloat(row.margin_requirement_short),
    attributes: row.attributes
});

const loadAssets = async (): Promise<Map<string, AssetRow> | null> => {
    if (!state.assets || Date.now() - state.loadedAt > RELOAD_MS) {
        state.loading ??= pool.query<AssetDbRow>("SELECT * FROM assets").then(({ rows }) => {
            state.assets = new Map(rows.map(row => [row.symbol, fromDb(row)]));
            state.loadedAt = Date.now();
        }, (error: { code?: string; message: string }) => {
            // Until migration 012_assets.sql is applied, the universe is empty
            if (error.code !== "42P01") throw error;
            if (!state.warned) console.warn(`Assets: ${error.message}; apply db/migrations/012_assets.sql`);
            state.warned = true;
            state.assets = new Map();
            state.loadedAt = Date.now();
        }).finally(() => {
            state.loading = null;
        });
        await state.loading;
    }
    return state.assets && state.assets.size > 0 ? state.assets : null;
};

// The asset for a symbol, or null when it isn't in the universe. undefined while the universe is empty (never synced).
export const findAsset = async (symbol: string): Promise<AssetRow | null | undefined> => {
    const assets = await loadAssets();
    if (!assets) return undefined;
    return assets.get(normalizeSymbol(symbol)) ?? null;
};

// Every asset in the universe, by symbol (empty while it's never been synced)
export const allAssets = async (): Promise<AssetRow[]> => [...((await loadAssets())?.values() ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol));

// Throws 404 unless symbol is a tradable stock in the universe (ETFs, funds and OTC listings aren't)
export const requireTradableStock = async (symbol: string): Promise<AssetRow | null> => {
    const asset = await findAsset(symbol);
    if (asset === undefined) {
        if (!state.warned) console.warn("Assets: the tradable universe is empty (not synced yet), so no ticker is refused");
        state.warned = true;
        return null;
    }
    if (!asset || asset.tradable === false) {
        throw new HttpError(`${symbol.toUpperCase()} isn't a tradable U.S. common stock here (ETFs, funds and OTC listings aren't offered)`, 404);
    }
    return asset;
};

// Which of these symbols are in the universe (all of them while it's empty)
export const filterTradable = async (symbols: string[]): Promise<string[]> => {
    const assets = await loadAssets();
    if (!assets) return symbols;
    return symbols.filter(symbol => {
        const asset = assets.get(normalizeSymbol(symbol));
        return asset !== undefined && asset.tradable !== false;
    });
};

// Rebuilds the universe from Alpha Vantage's listings and, with keys, Alpaca's assets, and replaces the table in one transaction.
// A failed Alpaca fetch keeps the previous sync rather than storing a universe without flags.
export const syncAssets = async (label: string): Promise<number> => {
    const listings = await fetchListings();
    const alpacaAssets = isAlpacaConfigured() ? await fetchAlpacaAssets() : null;
    const rows = buildUniverse(listings, alpacaAssets);
    if (rows.length === 0) throw new Error("the listings had no tradable stocks; keeping the previous universe");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM assets");
        // In batches, to stay under Postgres's parameter limit
        for (let i = 0; i < rows.length; i += 1000) {
            const batch = rows.slice(i, i + 1000);
            const values = batch.map((_, j) => `(${Array.from({ length: 12 }, (_, k) => `$${j * 12 + k + 1}`).join(", ")})`).join(", ");
            await client.query(
                `INSERT INTO assets (symbol, name, exchange, alpaca_id, tradable, marginable, shortable, borrow_status, fractionable,
                                     margin_requirement_long, margin_requirement_short, attributes) VALUES ${values}`,
                batch.flatMap(row => [row.symbol, row.name.slice(0, 255), row.exchange, row.alpacaId, row.tradable, row.marginable, row.shortable,
                    row.borrowStatus, row.fractionable, row.marginRequirementLong, row.marginRequirementShort, row.attributes])
            );
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    state.assets = new Map(rows.map(row => [row.symbol, row]));
    state.loadedAt = Date.now();
    console.log(`${label}: synced ${rows.length} tradable stocks${alpacaAssets ? " with Alpaca's flags" : " (no Alpaca keys, so without trading flags)"}`);
    return rows.length;
};
