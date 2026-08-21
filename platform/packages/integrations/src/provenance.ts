import { AsyncLocalStorage } from "node:async_hooks";
import type { NiaPort } from "./nia.js";
import type { SmsPort } from "./sms.js";
import type { TrackerPort } from "./tracker.js";

const simulatorAdapters = new WeakSet<object>();
const productionCapabilities = new WeakMap<
  object,
  ReadonlySet<ProductionAdapterCapability>
>();

export type ProductionAdapterCapability =
  | "SMS"
  | "NIA"
  | "OBJECT_STORAGE"
  | "MALWARE_SCANNER"
  | "TRACKER";

export interface ExternalConnectorProvenance {
  packageName: string;
  packageVersion: string;
  connectorId: string;
}

export interface ProductionConnectorBoundary {
  register(input: {
    kind: "SMS";
    provenance: ExternalConnectorProvenance;
    adapter: SmsPort;
  }): SmsPort;
  register(input: {
    kind: "NIA";
    provenance: ExternalConnectorProvenance;
    adapter: NiaPort;
  }): NiaPort;
  register(input: {
    kind: "TRACKER";
    provenance: ExternalConnectorProvenance;
    adapter: TrackerPort;
  }): TrackerPort;
  require<T extends object>(
    adapter: T,
    kind: "SMS" | "NIA" | "TRACKER",
  ): T;
}

const simulatorUse = new AsyncLocalStorage<{ used: boolean }>();

export function markSimulatorAdapter<T extends object>(adapter: T): T {
  simulatorAdapters.add(adapter);
  return adapter;
}

export function recordSimulatorAdapterUse(): void {
  const context = simulatorUse.getStore();
  if (context !== undefined) context.used = true;
}

export function isSimulatorAdapter(value: unknown): boolean {
  return (typeof value === "object" && value !== null) ||
    typeof value === "function"
    ? simulatorAdapters.has(value as object)
    : false;
}

export function markProductionAdapter<T extends object>(
  adapter: T,
  capability: ProductionAdapterCapability,
): T {
  const existing = productionCapabilities.get(adapter) ?? new Set();
  productionCapabilities.set(
    adapter,
    new Set([
      ...existing,
      capability,
    ]) as ReadonlySet<ProductionAdapterCapability>,
  );
  return adapter;
}

export function hasProductionAdapterCapability(
  value: unknown,
  capability: ProductionAdapterCapability,
): boolean {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    (productionCapabilities.get(value as object)?.has(capability) ?? false)
  );
}

export function requireProductionConnector<T extends object>(
  adapter: T,
  capability: ProductionAdapterCapability,
): T {
  if (isSimulatorAdapter(adapter)) {
    throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  }
  if (!hasProductionAdapterCapability(adapter, capability)) {
    throw new Error("PRODUCTION_CONNECTOR_CAPABILITY_REQUIRED");
  }
  return adapter;
}

export function createProductionConnectorBoundary(): ProductionConnectorBoundary {
  const registered = new WeakMap<object, "SMS" | "NIA" | "TRACKER">();
  function register(input: {
    kind: "SMS" | "NIA" | "TRACKER";
    provenance: ExternalConnectorProvenance;
    adapter: SmsPort | NiaPort | TrackerPort;
  }): SmsPort | NiaPort | TrackerPort {
    validateExternalConnectorProvenance(input.provenance);
    if (isSimulatorAdapter(input.adapter)) {
      throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    }
    const connector =
      input.kind === "SMS"
        ? createExternalSmsConnector(input.adapter as SmsPort)
        : input.kind === "NIA"
          ? createExternalNiaConnector(input.adapter as NiaPort)
          : createExternalTrackerConnector(input.adapter as TrackerPort);
    markProductionAdapter(connector, input.kind);
    registered.set(connector, input.kind);
    return connector;
  }
  return Object.freeze({
    register: register as ProductionConnectorBoundary["register"],
    require<T extends object>(
      adapter: T,
      kind: "SMS" | "NIA" | "TRACKER",
    ): T {
      if (registered.get(adapter) !== kind) {
        throw new Error("PRODUCTION_CONNECTOR_REGISTRATION_REQUIRED");
      }
      return adapter;
    },
  });
}

function createExternalSmsConnector(adapter: SmsPort | NiaPort): SmsPort {
  if (typeof (adapter as Partial<SmsPort>).send !== "function") {
    throw new Error("PRODUCTION_CONNECTOR_METHOD_INVALID");
  }
  const send = (adapter as SmsPort).send.bind(adapter);
  return Object.freeze({
    send: (input: Parameters<SmsPort["send"]>[0]) =>
      runExternalConnectorOperation(() => send(input)),
  });
}

function createExternalNiaConnector(adapter: SmsPort | NiaPort): NiaPort {
  if (typeof (adapter as Partial<NiaPort>).verify !== "function") {
    throw new Error("PRODUCTION_CONNECTOR_METHOD_INVALID");
  }
  const verify = (adapter as NiaPort).verify.bind(adapter);
  return Object.freeze({
    verify: (input: Parameters<NiaPort["verify"]>[0]) =>
      runExternalConnectorOperation(() => verify(input)),
  });
}

function createExternalTrackerConnector(adapter: TrackerPort): TrackerPort {
  if (typeof adapter.getLastKnown !== "function") {
    throw new Error("PRODUCTION_CONNECTOR_METHOD_INVALID");
  }
  const getLastKnown = adapter.getLastKnown.bind(adapter);
  return Object.freeze({
    getLastKnown: (input: Parameters<TrackerPort["getLastKnown"]>[0]) =>
      runExternalConnectorOperation(() => getLastKnown(input)),
  });
}

async function runExternalConnectorOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const context = { used: false };
  try {
    const result = await simulatorUse.run(context, operation);
    if (context.used) throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    return result;
  } catch (cause) {
    if (context.used) {
      throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION", { cause });
    }
    throw cause;
  }
}

function validateExternalConnectorProvenance(
  provenance: ExternalConnectorProvenance,
): void {
  if (
    !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(
      provenance.packageName,
    ) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(
      provenance.packageVersion,
    ) ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(provenance.connectorId)
  ) {
    throw new Error("PRODUCTION_CONNECTOR_PROVENANCE_INVALID");
  }
}
