// Checks objects against the vendored Alpaca OpenAPI specs (vendor/alpaca), so the simulator's replies can't drift from the
// real API's shapes. Used by the tests; loads the specs from disk, so it's for Node, not the pages.
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

export type AlpacaSpec = "broker-api" | "trading-api" | "market-data-api";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Alpaca's own formats, which it documents but JSON Schema doesn't define
for (const format of ["decimal", "int", "float", "double", "int32", "int64", "uint64", "uint32", "ulid"]) ajv.addFormat(format, true);

const loaded = new Set<AlpacaSpec>();
const validators = new Map<string, ValidateFunction>();

const loadSpec = (spec: AlpacaSpec) => {
    if (loaded.has(spec)) return;
    const file = path.join(process.cwd(), "vendor", "alpaca", `${spec}.json`);
    ajv.addSchema({ ...JSON.parse(readFileSync(file, "utf8")), $id: spec });
    loaded.add(spec);
};

// The validation errors of value against the spec's components.schemas[schema] (empty when it conforms)
export const conformanceErrors = (value: unknown, schema: string, spec: AlpacaSpec = "broker-api"): string[] => {
    loadSpec(spec);
    const key = `${spec}#/components/schemas/${schema}`;
    let validate = validators.get(key);
    if (!validate) {
        validate = ajv.compile({ $ref: key });
        validators.set(key, validate);
    }
    return validate(value) ? [] : (validate.errors ?? []).map(({ instancePath, message }) => `${instancePath || "/"} ${message}`);
};
