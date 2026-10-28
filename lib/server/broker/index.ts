import "server-only";
import { brokerMode, type Broker } from "./broker";
import { SimBroker } from "./sim";
import { createAlpacaBroker } from "./alpaca";

export type { Broker, BrokerEvent, BrokerEventStream } from "./broker";
export { brokerMode } from "./broker";
export { BrokerError } from "./errors";

// The broker the app trades through (BROKER: sim, the default, or alpaca for Alpaca's Broker API). It's created per module rather
// than once on globalThis (singleton): a shared instance would outlive dev hot reloads and other route bundles, throwing errors from
// a stale copy of the error classes. (AlpacaBroker's token is per instance, so each bundle fetches its own.)
let broker: Broker | null = null;
export const getBroker = (): Broker => {
    broker ??= brokerMode() === "alpaca" ? createAlpacaBroker() : new SimBroker();
    return broker;
};
