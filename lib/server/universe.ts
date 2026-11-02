// Which symbols can be traded: U.S. common stocks on the listed exchanges, no ETFs, funds, warrants, units, rights, preferreds or
// OTC listings. Pure, so it can be tested; lib/server/assets.ts fetches the inputs and stores the result.

// A row of Alpha Vantage's LISTING_STATUS, which tells stocks (assetType Stock) from ETFs
export interface ListingInput {
    symbol: string;
    name: string;
    exchange: string;
    assetType: string;
}

// The parts of an Alpaca asset used here (GET /v2/assets)
export interface AlpacaAssetInput {
    id: string;
    symbol: string;
    name?: string;
    exchange: string;
    tradable: boolean;
    marginable: boolean;
    shortable: boolean;
    fractionable: boolean;
    borrow_status?: string | null;
    easy_to_borrow?: boolean;
    margin_requirement_long?: string | null;
    margin_requirement_short?: string | null;
    attributes?: string[] | null;
}

export interface AssetRow {
    symbol: string;
    name: string;
    exchange: string;
    alpacaId: string | null;
    // Alpaca's trading flags, null without Alpaca
    tradable: boolean | null;
    marginable: boolean | null;
    shortable: boolean | null;
    borrowStatus: string | null;
    fractionable: boolean | null;
    marginRequirementLong: number | null;
    marginRequirementShort: number | null;
    attributes: string[];
}

// Alpha Vantage's names for the listed exchanges, and Alpaca's
const LISTED_EXCHANGES = new Set(["NYSE", "NASDAQ", "NYSE MKT", "NYSE ARCA", "BATS", "AMEX", "ARCA", "NYSEARCA"]);

// Securities Alpha Vantage lists as stocks that aren't common shares: warrants, units, rights, preferreds and notes, by name, and by
// Nasdaq's fifth-letter codes (W warrant, U unit, R rights)
const NOT_COMMON_NAME = /\b(warrants?|units?|rights?|preferred|pfd|notes? due|debentures?|subordinated)\b/i;
const isCommonStock = (symbol: string, name: string, exchange: string) =>
    !NOT_COMMON_NAME.test(name) && !(exchange.toUpperCase() === "NASDAQ" && /^[A-Z]{4}[WUR]$/.test(symbol));

// Alpha Vantage writes share classes with a hyphen (BRK-A), Alpaca with a dot (BRK.A); the app uses the dot
export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase().replaceAll("-", ".");

const percentOrNull = (value: string | null | undefined): number | null => {
    const number = parseFloat(value ?? "");
    return Number.isFinite(number) ? number : null;
};

// The tradable universe from the listings and, when available, Alpaca's assets. With Alpaca, a stock must also be on Alpaca's list
// and tradable there, and gets its flags; without it (alpacaAssets null), every listed stock counts, with unknown flags.
// Alpha Vantage's assetType decides what's a stock, since Alpaca doesn't mark ETFs.
export const buildUniverse = (listings: ListingInput[], alpacaAssets: AlpacaAssetInput[] | null): AssetRow[] => {
    const alpaca = alpacaAssets ? new Map(alpacaAssets.map(asset => [normalizeSymbol(asset.symbol), asset])) : null;
    const rows = new Map<string, AssetRow>();
    for (const listing of listings) {
        if (listing.assetType !== "Stock" || !LISTED_EXCHANGES.has(listing.exchange.toUpperCase())) continue;
        const symbol = normalizeSymbol(listing.symbol);
        if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol) || !isCommonStock(symbol, listing.name, listing.exchange)) continue;
        const asset = alpaca?.get(symbol);
        if (alpaca && (!asset || !asset.tradable || !LISTED_EXCHANGES.has(asset.exchange.toUpperCase()))) continue;
        rows.set(symbol, {
            symbol,
            name: listing.name || asset?.name || symbol,
            exchange: asset?.exchange ?? listing.exchange,
            alpacaId: asset?.id ?? null,
            tradable: asset ? asset.tradable : null,
            marginable: asset ? asset.marginable : null,
            shortable: asset ? asset.shortable : null,
            borrowStatus: asset ? asset.borrow_status ?? (asset.easy_to_borrow ? "easy_to_borrow" : asset.shortable ? "hard_to_borrow" : null) : null,
            fractionable: asset ? asset.fractionable : null,
            marginRequirementLong: percentOrNull(asset?.margin_requirement_long),
            marginRequirementShort: percentOrNull(asset?.margin_requirement_short),
            attributes: asset?.attributes ?? []
        });
    }
    return [...rows.values()];
};
