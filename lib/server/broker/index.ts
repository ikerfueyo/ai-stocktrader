import "server-only";
import { brokerMode, type Broker } from "./broker";
import { SimBroker } from "./sim";

export type { Broker, BrokerEvent, BrokerEventStream } from "./broker";
export { BrokerError } from "./errors";

// The broker the app trades through (BROKER, default sim). It keeps no state in memory, so it's created per module rather than once
// on globalThis (singleton): a shared instance would outlive dev hot reloads and other route bundles, throwing errors from a stale
// copy of the error classes.
let broker: Broker | null = null;
export const getBroker = (): Broker => {
    if (!broker) {
        brokerMode();
        broker = new SimBroker();
    }
    return broker;
};
